'use strict';
import * as paths from 'path';
import {
	commands,
	ConfigurationChangeEvent,
	Disposable,
	Event,
	EventEmitter,
	ProgressLocation,
	RelativePattern,
	Uri,
	window,
	workspace,
	WorkspaceFolder,
} from 'vscode';
import { BranchSorting, configuration, TagSorting } from '../../configuration';
import { Starred, WorkspaceState } from '../../constants';
import { Container } from '../../container';
import {
	GitBranch,
	GitContributor,
	GitDiffShortStat,
	GitRemote,
	GitStash,
	GitStatus,
	GitTag,
	SearchPattern,
} from '../git';
import { GitService } from '../gitService';
import { GitUri } from '../gitUri';
import { Logger } from '../../logger';
import { Messages } from '../../messages';
import {
	GitBranchReference,
	GitLog,
	GitLogCommit,
	GitMergeStatus,
	GitRebaseStatus,
	GitReference,
	GitTagReference,
} from './models';
import { RemoteProviderFactory, RemoteProviders, RichRemoteProvider } from '../remotes/factory';
import { Arrays, Dates, debug, Functions, gate, Iterables, log, logName } from '../../system';
import { runGitCommandInTerminal } from '../../terminal';

const ignoreGitRegex = /\.git(?:\/|\\|$)/;
const refsRegex = /\.git\/refs\/(heads|remotes|tags)/;

export enum RepositoryChange {
	Config = 'config',
	Closed = 'closed',
	// FileSystem = 'file-system',
	Starred = 'starred',
	Heads = 'heads',
	Index = 'index',
	Ignores = 'ignores',
	Remotes = 'remotes',
	Stash = 'stash',
	Tags = 'tags',
	Unknown = 'unknown',
}

export class RepositoryChangeEvent {
	constructor(public readonly repository?: Repository, public readonly changes: RepositoryChange[] = []) {}

	changed(change: RepositoryChange, only: boolean = false) {
		if (only) {
			if (this.changes.length !== 1) return false;
			if (this.changes[0] === change) return true;

			if (this.repository?.supportsChangeEvents === false && this.changes[0] === RepositoryChange.Unknown) {
				switch (change) {
					case RepositoryChange.Closed:
					case RepositoryChange.Starred:
						return false;
					default:
						return true;
				}
			}

			return false;
		}

		if (this.changes.includes(change)) return true;

		if (this.repository?.supportsChangeEvents === false && this.changes.includes(RepositoryChange.Unknown)) {
			switch (change) {
				case RepositoryChange.Closed:
				case RepositoryChange.Ignores:
				case RepositoryChange.Starred:
					return false;
				default:
					return true;
			}
		}

		return false;
	}
}

export interface RepositoryFileSystemChangeEvent {
	readonly repository?: Repository;
	readonly uris: Uri[];
}

@logName<Repository>((r, name) => `${name}(${r.id})`)
export class Repository implements Disposable {
	static formatLastFetched(lastFetched: number, short: boolean = true): string {
		const formatter = Dates.getFormatter(new Date(lastFetched));
		if (Date.now() - lastFetched < Dates.MillisecondsPerDay) {
			return formatter.fromNow();
		}

		if (short) {
			return formatter.format(Container.config.defaultDateShortFormat ?? 'MMM D, YYYY');
		}

		let format =
			Container.config.defaultDateFormat ??
			`dddd, MMMM Do, YYYY [at] ${Container.config.defaultTimeFormat ?? 'h:mma'}`;
		if (!/[hHm]/.test(format)) {
			format += ` [at] ${Container.config.defaultTimeFormat ?? 'h:mma'}`;
		}
		return formatter.format(format);
	}

	static getLastFetchedUpdateInterval(lastFetched: number): number {
		const timeDiff = Date.now() - lastFetched;
		return timeDiff < Dates.MillisecondsPerDay
			? (timeDiff < Dates.MillisecondsPerHour ? Dates.MillisecondsPerMinute : Dates.MillisecondsPerHour) / 2
			: 0;
	}

	static sort(repositories: Repository[]) {
		return repositories.sort((a, b) => (a.starred ? -1 : 1) - (b.starred ? -1 : 1) || a.index - b.index);
	}

	private _onDidChange = new EventEmitter<RepositoryChangeEvent>();
	get onDidChange(): Event<RepositoryChangeEvent> {
		return this._onDidChange.event;
	}

	private _onDidChangeFileSystem = new EventEmitter<RepositoryFileSystemChangeEvent>();
	get onDidChangeFileSystem(): Event<RepositoryFileSystemChangeEvent> {
		return this._onDidChangeFileSystem.event;
	}

	readonly formattedName: string;
	readonly id: string;
	readonly index: number;
	readonly name: string;
	readonly normalizedPath: string;
	readonly supportsChangeEvents: boolean = true;

	private _branch: Promise<GitBranch | undefined> | undefined;
	private readonly _disposable: Disposable;
	private _fireChangeDebounced: (() => void) | undefined = undefined;
	private _fireFileSystemChangeDebounced: (() => void) | undefined = undefined;
	private _fsWatchCounter = 0;
	private _fsWatcherDisposable: Disposable | undefined;
	private _pendingFileSystemChange?: RepositoryFileSystemChangeEvent;
	private _pendingRepoChange?: RepositoryChangeEvent;
	private _providers: RemoteProviders | undefined;
	private _remotes: Promise<GitRemote[]> | undefined;
	private _remotesDisposable: Disposable | undefined;
	private _suspended: boolean;

	constructor(
		public readonly folder: WorkspaceFolder,
		public readonly path: string,
		public readonly root: boolean,
		private readonly onAnyRepositoryChanged: (repo: Repository, e: RepositoryChangeEvent) => void,
		suspended: boolean,
		closed: boolean = false,
	) {
		const relativePath = paths.relative(folder.uri.fsPath, path);
		if (root) {
			// Check if the repository is not contained by a workspace folder
			const repoFolder = workspace.getWorkspaceFolder(GitUri.fromRepoPath(path));
			if (repoFolder == null) {
				// If it isn't within a workspace folder we can't get change events, see: https://github.com/Microsoft/vscode/issues/3025
				this.supportsChangeEvents = false;
				this.formattedName = this.name = paths.basename(path);
			} else {
				this.formattedName = this.name = folder.name;
			}
		} else {
			this.formattedName = relativePath ? `${folder.name} (${relativePath})` : folder.name;
			this.name = folder.name;
		}
		this.index = folder.index;

		this.normalizedPath = (path.endsWith('/') ? path : `${path}/`).toLowerCase();
		this.id = this.normalizedPath;

		this._suspended = suspended;
		this._closed = closed;

		// TODO: createFileSystemWatcher doesn't work unless the folder is part of the workspaceFolders
		// https://github.com/Microsoft/vscode/issues/3025
		const watcher = workspace.createFileSystemWatcher(
			new RelativePattern(
				folder,
				'{\
**/.git/config,\
**/.git/index,\
**/.git/HEAD,\
**/.git/refs/stash,\
**/.git/refs/heads/**,\
**/.git/refs/remotes/**,\
**/.git/refs/tags/**,\
**/.gitignore\
}',
			),
		);
		this._disposable = Disposable.from(
			watcher,
			watcher.onDidChange(this.onRepositoryChanged, this),
			watcher.onDidCreate(this.onRepositoryChanged, this),
			watcher.onDidDelete(this.onRepositoryChanged, this),
			configuration.onDidChange(this.onConfigurationChanged, this),
		);
		this.onConfigurationChanged(configuration.initializingChangeEvent);

		if (!this.supportsChangeEvents && Logger.willLog('debug')) {
			Logger.debug(
				`Repository[${this.name}(${
					this.id
				})] doesn't support file watching; path=${path}, workspaceFolders=${workspace.workspaceFolders
					?.map(wf => wf.uri.fsPath)
					.join('; ')}`,
			);
		}
	}

	dispose() {
		this.stopWatchingFileSystem();

		// // Clean up any disposables in storage
		// for (const item of this.storage.values()) {
		//     if (item != null && typeof item.dispose === 'function') {
		//         item.dispose();
		//     }
		// }

		this._remotesDisposable?.dispose();
		this._disposable?.dispose();
	}

	private _updatedAt: number = 0;
	get updatedAt(): number {
		return this._updatedAt;
	}

	private onConfigurationChanged(e: ConfigurationChangeEvent) {
		if (configuration.changed(e, 'remotes', this.folder.uri)) {
			this._providers = RemoteProviderFactory.loadProviders(configuration.get('remotes', this.folder.uri));

			if (!configuration.initializing(e)) {
				this.resetRemotesCache();
				this.fireChange(RepositoryChange.Remotes);
			}
		}
	}

	private onFileSystemChanged(uri: Uri) {
		// Ignore .git changes
		if (ignoreGitRegex.test(uri.fsPath)) return;

		this.fireFileSystemChange(uri);
	}

	@debug()
	private onRepositoryChanged(uri: Uri | undefined) {
		this._lastFetched = undefined;

		if (uri == null) {
			this.fireChange(RepositoryChange.Unknown);

			return;
		}

		if (uri.path.endsWith('.git/config')) {
			this._branch = undefined;
			this.resetRemotesCache();
			this.fireChange(RepositoryChange.Config, RepositoryChange.Remotes);

			return;
		}

		if (uri.path.endsWith('.git/index')) {
			this.fireChange(RepositoryChange.Index);

			return;
		}

		if (uri.path.endsWith('.git/HEAD') || uri.path.endsWith('.git/ORIG_HEAD')) {
			this._branch = undefined;
			this.fireChange(RepositoryChange.Heads);

			return;
		}

		if (uri.path.endsWith('.git/refs/stash')) {
			this.fireChange(RepositoryChange.Stash);

			return;
		}

		if (uri.path.endsWith('/.gitignore')) {
			this.fireChange(RepositoryChange.Ignores);

			return;
		}

		const match = refsRegex.exec(uri.path);
		if (match != null) {
			switch (match[1]) {
				case 'heads':
					this._branch = undefined;
					this.fireChange(RepositoryChange.Heads);

					return;
				case 'remotes':
					this._branch = undefined;
					this.resetRemotesCache();
					this.fireChange(RepositoryChange.Remotes);

					return;
				case 'tags':
					this.fireChange(RepositoryChange.Tags);

					return;
			}
		}

		this.fireChange(RepositoryChange.Unknown);
	}

	private _closed: boolean = false;
	get closed(): boolean {
		return this._closed;
	}
	set closed(value: boolean) {
		const changed = this._closed !== value;
		this._closed = value;
		if (changed) {
			this.fireChange(RepositoryChange.Closed);
		}
	}

	@gate()
	@log()
	branch(...args: string[]) {
		this.runTerminalCommand('branch', ...args);
	}

	@gate()
	@log()
	branchDelete(
		branches: GitBranchReference | GitBranchReference[],
		{ force, remote }: { force?: boolean; remote?: boolean } = {},
	) {
		if (!Array.isArray(branches)) {
			branches = [branches];
		}

		const localBranches = branches.filter(b => !b.remote);
		if (localBranches.length !== 0) {
			const args = ['--delete'];
			if (force) {
				args.push('--force');
			}
			this.runTerminalCommand('branch', ...args, ...branches.map(b => b.ref));

			if (remote) {
				const trackingBranches = localBranches.filter(b => b.tracking != null);
				if (trackingBranches.length !== 0) {
					const branchesByOrigin = Arrays.groupByMap(trackingBranches, b => GitBranch.getRemote(b.tracking!));

					for (const [remote, branches] of branchesByOrigin.entries()) {
						this.runTerminalCommand(
							'push',
							'-d',
							remote,
							...branches.map(b => GitBranch.getNameWithoutRemote(b.tracking!)),
						);
					}
				}
			}
		}

		const remoteBranches = branches.filter(b => b.remote);
		if (remoteBranches.length !== 0) {
			const branchesByOrigin = Arrays.groupByMap(remoteBranches, b => GitBranch.getRemote(b.name));

			for (const [remote, branches] of branchesByOrigin.entries()) {
				this.runTerminalCommand(
					'push',
					'-d',
					remote,
					...branches.map(b => GitReference.getNameWithoutRemote(b)),
				);
			}
		}
	}

	@gate(() => '')
	@log()
	cherryPick(...args: string[]) {
		this.runTerminalCommand('cherry-pick', ...args);
	}

	containsUri(uri: Uri) {
		if (GitUri.is(uri)) {
			uri = uri.repoPath != null ? GitUri.file(uri.repoPath) : uri.documentUri();
		}

		return this.folder === workspace.getWorkspaceFolder(uri);
	}

	@gate()
	@log()
	async fetch(
		options: {
			all?: boolean;
			branch?: GitBranchReference;
			progress?: boolean;
			prune?: boolean;
			pull?: boolean;
			remote?: string;
		} = {},
	) {
		const { progress, ...opts } = { progress: true, ...options };
		if (!progress) return this.fetchCore(opts);

		return void (await window.withProgress(
			{
				location: ProgressLocation.Notification,
				title:
					opts.branch != null
						? `${opts.pull ? 'Pulling' : 'Fetching'} ${opts.branch.name}...`
						: `Fetching ${opts.remote ? `${opts.remote} of ` : ''}${this.formattedName}...`,
			},
			() => this.fetchCore(opts),
		));
	}

	private async fetchCore(
		options: { all?: boolean; branch?: GitBranchReference; prune?: boolean; pull?: boolean; remote?: string } = {},
	) {
		try {
			void (await Container.git.fetch(this.path, options));

			this.fireChange(RepositoryChange.Unknown);
		} catch (ex) {
			Logger.error(ex);
			void Messages.showGenericErrorMessage('Unable to fetch repository');
		}
	}

	async getBranch(name?: string): Promise<GitBranch | undefined> {
		if (name) {
			const [branch] = await this.getBranches({ filter: b => b.name === name });
			return branch;
		}

		if (this._branch == null || !this.supportsChangeEvents) {
			this._branch = Container.git.getBranch(this.path);
		}
		return this._branch;
	}

	getBranches(
		options: {
			filter?: (b: GitBranch) => boolean;
			sort?: boolean | { current?: boolean; orderBy?: BranchSorting };
		} = {},
	): Promise<GitBranch[]> {
		return Container.git.getBranches(this.path, options);
	}

	getBranchesAndOrTags(
		options: {
			filter?: { branches?: (b: GitBranch) => boolean; tags?: (t: GitTag) => boolean };
			include?: 'all' | 'branches' | 'tags';
			sort?:
				| boolean
				| { branches?: { current?: boolean; orderBy?: BranchSorting }; tags?: { orderBy?: TagSorting } };
		} = {},
	) {
		return Container.git.getBranchesAndOrTags(this.path, options);
	}

	getChangedFilesCount(sha?: string): Promise<GitDiffShortStat | undefined> {
		return Container.git.getChangedFilesCount(this.path, sha);
	}

	getCommit(ref: string): Promise<GitLogCommit | undefined> {
		return Container.git.getCommit(this.path, ref);
	}

	getContributors(): Promise<GitContributor[]> {
		return Container.git.getContributors(this.path);
	}

	private _lastFetched: number | undefined;
	@gate()
	async getLastFetched(): Promise<number> {
		if (this._lastFetched == null) {
			const hasRemotes = await this.hasRemotes();
			if (!hasRemotes || Container.vsls.isMaybeGuest) return 0;
		}

		try {
			const stat = await workspace.fs.stat(Uri.file(paths.join(this.path, '.git/FETCH_HEAD')));
			// If the file is empty, assume the fetch failed, and don't update the timestamp
			if (stat.size > 0) {
				this._lastFetched = stat.mtime;
			}
		} catch {
			this._lastFetched = undefined;
		}

		return this._lastFetched ?? 0;
	}

	getMergeStatus(): Promise<GitMergeStatus | undefined> {
		return Container.git.getMergeStatus(this.path);
	}

	getRebaseStatus(): Promise<GitRebaseStatus | undefined> {
		return Container.git.getRebaseStatus(this.path);
	}

	getRemotes(_options: { sort?: boolean } = {}): Promise<GitRemote[]> {
		if (this._remotes == null || !this.supportsChangeEvents) {
			if (this._providers == null) {
				const remotesCfg = configuration.get('remotes', this.folder.uri);
				this._providers = RemoteProviderFactory.loadProviders(remotesCfg);
			}

			// Since we are caching the results, always sort
			this._remotes = Container.git.getRemotesCore(this.path, this._providers, { sort: true });
			void this.subscribeToRemotes(this._remotes);
		}

		return this._remotes;
	}

	async getRichRemote(connectedOnly: boolean = false): Promise<GitRemote<RichRemoteProvider> | undefined> {
		return Container.git.getRichRemoteProvider(await this.getRemotes(), { includeDisconnected: !connectedOnly });
	}

	private resetRemotesCache() {
		this._remotes = undefined;
		this._remotesDisposable?.dispose();
		this._remotesDisposable = undefined;
	}

	private async subscribeToRemotes(remotes: Promise<GitRemote[]>) {
		this._remotesDisposable?.dispose();
		this._remotesDisposable = undefined;

		this._remotesDisposable = Disposable.from(
			...Iterables.filterMap(await remotes, r => {
				if (!RichRemoteProvider.is(r.provider)) return undefined;

				return r.provider.onDidChange(() => this.fireChange(RepositoryChange.Remotes));
			}),
		);
	}

	getStash(): Promise<GitStash | undefined> {
		return Container.git.getStash(this.path);
	}

	getStatus(): Promise<GitStatus | undefined> {
		return Container.git.getStatusForRepo(this.path);
	}

	getTags(options?: {
		filter?: (t: GitTag) => boolean;
		sort?: boolean | { orderBy?: TagSorting };
	}): Promise<GitTag[]> {
		return Container.git.getTags(this.path, options);
	}

	async hasRemotes(): Promise<boolean> {
		const remotes = await this.getRemotes();
		return remotes?.length > 0;
	}

	async hasRichRemote(connectedOnly: boolean = false): Promise<boolean> {
		const remote = await this.getRichRemote(connectedOnly);
		return remote?.provider != null;
	}

	async hasTrackingBranch(): Promise<boolean> {
		const branch = await this.getBranch();
		return branch?.tracking != null;
	}

	@gate(() => '')
	@log()
	merge(...args: string[]) {
		this.runTerminalCommand('merge', ...args);
	}

	@gate()
	@log()
	async pull(options: { progress?: boolean; rebase?: boolean } = {}) {
		const { progress, ...opts } = { progress: true, ...options };
		if (!progress) return this.pullCore();

		return void (await window.withProgress(
			{
				location: ProgressLocation.Notification,
				title: `Pulling ${this.formattedName}...`,
			},
			() => this.pullCore(opts),
		));
	}

	private async pullCore(options: { rebase?: boolean } = {}) {
		try {
			const tracking = await this.hasTrackingBranch();
			if (tracking) {
				void (await commands.executeCommand(options.rebase ? 'git.pullRebase' : 'git.pull', this.path));
			} else if (configuration.getAny<boolean>('git.fetchOnPull', Uri.file(this.path))) {
				void (await Container.git.fetch(this.path));
			}

			this.fireChange(RepositoryChange.Unknown);
		} catch (ex) {
			Logger.error(ex);
			void Messages.showGenericErrorMessage('Unable to pull repository');
		}
	}

	@gate()
	@log()
	async push(
		options: {
			force?: boolean;
			progress?: boolean;
			reference?: GitReference;
			publish?: {
				remote: string;
			};
		} = {},
	) {
		const { progress, ...opts } = { progress: true, ...options };
		if (!progress) return this.pushCore(opts);

		return void (await window.withProgress(
			{
				location: ProgressLocation.Notification,
				title: GitReference.isBranch(opts.reference)
					? `${opts.publish != null ? 'Publishing ' : 'Pushing '}${opts.reference.name}...`
					: `Pushing ${this.formattedName}...`,
			},
			() => this.pushCore(opts),
		));
	}

	private async pushCore(
		options: {
			force?: boolean;
			reference?: GitReference;
			publish?: {
				remote: string;
			};
		} = {},
	) {
		try {
			if (GitReference.isBranch(options.reference)) {
				const repo = await GitService.getBuiltInGitRepository(this.path);
				if (repo == null) return;

				if (options.publish != null) {
					await repo?.push(options.publish.remote, options.reference.name, true);
				} else {
					const branch = await this.getBranch(options.reference.name);
					if (branch == null) return;

					const currentBranch = await this.getBranch();
					if (branch.id === currentBranch?.id) {
						void (await commands.executeCommand(options.force ? 'git.pushForce' : 'git.push', this.path));
					} else {
						await repo?.push(branch.getRemoteName(), branch.name);
					}
				}
			} else if (options.reference != null) {
				const repo = await GitService.getBuiltInGitRepository(this.path);
				if (repo == null) return;

				const branch = await this.getBranch();
				if (branch == null) return;

				await repo?.push(branch.getRemoteName(), `${options.reference.ref}:${branch.getNameWithoutRemote()}`);
			} else {
				void (await commands.executeCommand(options.force ? 'git.pushForce' : 'git.push', this.path));
			}

			this.fireChange(RepositoryChange.Unknown);
		} catch (ex) {
			Logger.error(ex);
			void Messages.showGenericErrorMessage('Unable to push repository');
		}
	}

	@gate(() => '')
	@log()
	rebase(configs: string[] | undefined, ...args: string[]) {
		this.runTerminalCommand(
			configs != null && configs.length !== 0 ? `${configs.join(' ')} rebase` : 'rebase',
			...args,
		);
	}

	rebaseAbort() {
		return Container.git.rebaseAbort(this.path);
	}

	rebaseContinue() {
		return Container.git.rebaseContinue(this.path);
	}

	rebaseEditTodo() {
		return Container.git.rebaseEditTodo(this.path);
	}

	@gate(() => '')
	@log()
	reset(...args: string[]) {
		this.runTerminalCommand('reset', ...args);
	}

	resume() {
		if (!this._suspended) return;

		this._suspended = false;

		// If we've come back into focus and we are dirty, fire the change events

		if (this._pendingRepoChange != null) {
			this._fireChangeDebounced!();
		}

		if (this._pendingFileSystemChange != null) {
			this._fireFileSystemChangeDebounced!();
		}
	}

	@gate()
	@log()
	revert(...args: string[]) {
		this.runTerminalCommand('revert', ...args);
	}

	searchForCommits(
		search: SearchPattern,
		options: { limit?: number; skip?: number } = {},
	): Promise<GitLog | undefined> {
		return Container.git.getLogForSearch(this.path, search, options);
	}

	get starred() {
		const starred = Container.context.workspaceState.get<Starred>(WorkspaceState.StarredRepositories);
		return starred != null && starred[this.id] === true;
	}

	star(branch?: GitBranch) {
		return this.updateStarred(true, branch);
	}

	@gate(() => '')
	@log()
	async stashApply(stashName: string, options: { deleteAfter?: boolean } = {}) {
		void (await Container.git.stashApply(this.path, stashName, options));
		if (!this.supportsChangeEvents) {
			this.fireChange(RepositoryChange.Stash);
		}
	}

	@gate(() => '')
	@log()
	async stashDelete(stashName: string, ref?: string) {
		void (await Container.git.stashDelete(this.path, stashName, ref));
		if (!this.supportsChangeEvents) {
			this.fireChange(RepositoryChange.Stash);
		}
	}

	@gate(() => '')
	@log()
	async stashSave(message?: string, uris?: Uri[], options: { includeUntracked?: boolean; keepIndex?: boolean } = {}) {
		void (await Container.git.stashSave(this.path, message, uris, options));
		if (!this.supportsChangeEvents) {
			this.fireChange(RepositoryChange.Stash);
		}
	}

	@gate()
	@log()
	async switch(ref: string, options: { createBranch?: string | undefined; progress?: boolean } = {}) {
		const { progress, ...opts } = { progress: true, ...options };
		if (!progress) return this.switchCore(ref, opts);

		return void (await window.withProgress(
			{
				location: ProgressLocation.Notification,
				title: `Switching ${this.formattedName} to ${ref}...`,
				cancellable: false,
			},
			() => this.switchCore(ref, opts),
		));
	}

	private async switchCore(ref: string, options: { createBranch?: string } = {}) {
		try {
			void (await Container.git.checkout(this.path, ref, options));

			this.fireChange(RepositoryChange.Unknown);
		} catch (ex) {
			Logger.error(ex);
			void Messages.showGenericErrorMessage('Unable to switch to reference');
		}
	}

	toAbsoluteUri(path: string, options?: { validate?: boolean }): Uri | undefined {
		const uri = Uri.joinPath(GitUri.file(this.path), path);
		return !(options?.validate ?? true) || this.containsUri(uri) ? uri : undefined;
	}

	unstar(branch?: GitBranch) {
		return this.updateStarred(false, branch);
	}

	private async updateStarred(star: boolean, branch?: GitBranch) {
		if (branch != null) {
			await this.updateStarredCore(WorkspaceState.StarredBranches, branch.id, star);
		} else {
			await this.updateStarredCore(WorkspaceState.StarredRepositories, this.id, star);
		}

		this.fireChange(RepositoryChange.Starred);
	}

	private async updateStarredCore(key: WorkspaceState, id: string, star: boolean) {
		let starred = Container.context.workspaceState.get<Starred>(key);
		if (starred === undefined) {
			starred = Object.create(null) as Starred;
		}

		if (star) {
			starred[id] = true;
		} else {
			const { [id]: _, ...rest } = starred;
			starred = rest;
		}
		await Container.context.workspaceState.update(key, starred);

		this.fireChange(RepositoryChange.Starred);
	}

	startWatchingFileSystem(): Disposable {
		this._fsWatchCounter++;
		if (this._fsWatcherDisposable == null) {
			// TODO: createFileSystemWatcher doesn't work unless the folder is part of the workspaceFolders
			// https://github.com/Microsoft/vscode/issues/3025
			const watcher = workspace.createFileSystemWatcher(new RelativePattern(this.folder, '**'));
			this._fsWatcherDisposable = Disposable.from(
				watcher,
				watcher.onDidChange(this.onFileSystemChanged, this),
				watcher.onDidCreate(this.onFileSystemChanged, this),
				watcher.onDidDelete(this.onFileSystemChanged, this),
			);
		}

		return { dispose: () => this.stopWatchingFileSystem() };
	}

	stopWatchingFileSystem() {
		if (this._fsWatcherDisposable == null) return;
		if (--this._fsWatchCounter > 0) return;

		this._fsWatcherDisposable.dispose();
		this._fsWatcherDisposable = undefined;
	}

	suspend() {
		this._suspended = true;
	}

	@gate()
	@log()
	tag(...args: string[]) {
		this.runTerminalCommand('tag', ...args);
	}

	@gate()
	@log()
	tagDelete(tags: GitTagReference | GitTagReference[]) {
		if (!Array.isArray(tags)) {
			tags = [tags];
		}

		const args = ['--delete'];
		this.runTerminalCommand('tag', ...args, ...tags.map(t => t.ref));
	}

	@debug()
	private fireChange(...changes: RepositoryChange[]) {
		this._updatedAt = Date.now();

		if (this._fireChangeDebounced == null) {
			this._fireChangeDebounced = Functions.debounce(this.fireChangeCore.bind(this), 250);
		}

		if (this._pendingRepoChange == null) {
			this._pendingRepoChange = new RepositoryChangeEvent(this);
		}

		const e = this._pendingRepoChange;

		for (const reason of changes) {
			if (!e.changes.includes(reason)) {
				e.changes.push(reason);
			}
		}

		this.onAnyRepositoryChanged(this, new RepositoryChangeEvent(this, changes));

		if (this._suspended) {
			Logger.debug(`Repository[${this.name}(${this.id})] queueing suspended changes=${e.changes.join(', ')}`);

			return;
		}

		this._fireChangeDebounced();
	}

	private fireChangeCore() {
		const e = this._pendingRepoChange;
		if (e == null) return;

		this._pendingRepoChange = undefined;

		Logger.debug(`Repository[${this.name}(${this.id})] firing changes=${e.changes.join(', ')}`);
		this._onDidChange.fire(e);
	}

	@debug()
	private fireFileSystemChange(uri: Uri) {
		this._updatedAt = Date.now();

		if (this._fireFileSystemChangeDebounced == null) {
			this._fireFileSystemChangeDebounced = Functions.debounce(this.fireFileSystemChangeCore.bind(this), 2500);
		}

		if (this._pendingFileSystemChange == null) {
			this._pendingFileSystemChange = { repository: this, uris: [] };
		}

		const e = this._pendingFileSystemChange;
		e.uris.push(uri);

		if (this._suspended) {
			Logger.debug(
				`Repository[${this.name}(${this.id})] queueing suspended fs changes=${e.uris
					.map(u => u.fsPath)
					.join(', ')}`,
			);
			return;
		}

		this._fireFileSystemChangeDebounced();
	}

	private async fireFileSystemChangeCore() {
		let e = this._pendingFileSystemChange;
		if (e == null) return;

		this._pendingFileSystemChange = undefined;

		const uris = await Container.git.excludeIgnoredUris(this.path, e.uris);
		if (uris.length === 0) return;

		if (uris.length !== e.uris.length) {
			e = { ...e, uris: uris };
		}

		Logger.debug(`Repository[${this.name}(${this.id})] firing fs changes=${e.uris.map(u => u.fsPath).join(', ')}`);

		this._onDidChangeFileSystem.fire(e);
	}

	private runTerminalCommand(command: string, ...args: string[]) {
		const parsedArgs = args.map(arg => (arg.startsWith('#') ? `"${arg}"` : arg));
		runGitCommandInTerminal(command, parsedArgs.join(' '), this.path, true);
		if (!this.supportsChangeEvents) {
			this.fireChange(RepositoryChange.Unknown);
		}
	}
}
