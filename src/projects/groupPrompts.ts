'use strict';

import type * as vscode from 'vscode';
import { USER_CANCELED } from '../constants';

export interface GroupPromptWindow {
    showInputBox(options: vscode.InputBoxOptions): Thenable<string | undefined>;
}

export async function queryGroupName(window: GroupPromptWindow, defaultText: string = null): Promise<string> {
    var groupName = await window.showInputBox({
        value: defaultText || undefined,
        valueSelection: defaultText ? [0, defaultText.length] : undefined,
        placeHolder: 'Group Name',
        ignoreFocusOut: true,
        validateInput: (val: string) => val ? '' : 'A Group Name must be provided.',
    });

    if (groupName === null || groupName === undefined) {
        throw new Error(USER_CANCELED);
    }

    return groupName;
}
