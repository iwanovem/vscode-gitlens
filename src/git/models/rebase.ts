'use strict';
import { GitBranchReference, GitRevisionReference } from './models';

export interface GitRebaseStatus {
	type: 'rebase';
	repoPath: string;
	HEAD: GitRevisionReference;
	onto: GitRevisionReference;
	mergeBase: string | undefined;
	current: GitBranchReference | undefined;
	incoming: GitBranchReference;

	step: {
		commit: GitRevisionReference;
		number: number;
		total: number;
	};
}
