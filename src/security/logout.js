import { clearLocalData } from '../config/settings.store.js';
import { clearProviderSession } from '../providers/provider.manager.js';

export async function confirmLogout({ input, output = process.stdout, clearData = clearLocalData, clearCredentials = clearProviderSession, beforeDelete = async () => {} }) {
    if (!input.isInteractive) {
        output.write('Logout requires confirmation in an interactive terminal. No data was deleted.\n');
        return false;
    }
    output.write('\nLogout deletes all saved Puls API keys, settings, and command history, clears this conversation, and exits.\nWorkspace files remain. API keys set in your parent shell remain there.\n');
    try {
        while (true) {
            const answer = String(await input.question('Delete Puls data and log out? [yes/no] (default: no): ')).trim().toLowerCase();
            if (!answer || ['n', 'no'].includes(answer)) { output.write('Logout cancelled.\n'); return false; }
            if (['y', 'yes'].includes(answer)) break;
            output.write('Enter yes to delete Puls data, or no to cancel.\n');
        }
    } catch (error) {
        if (['INPUT_CANCELLED', 'ERR_INPUT_NOT_OPEN', 'ERR_USE_AFTER_CLOSE'].includes(error?.code)) { output.write('Logout cancelled.\n'); return false; }
        throw error;
    }
    // Prevent an earlier queued history save from recreating the deleted profile.
    await beforeDelete();
    await input.historyWrite;
    await clearData();
    clearCredentials();
    input.history = [];
    if (input.interface) input.interface.history = [];
    input.setDraft?.('');
    input.setFollowups?.([]);
    output.write('Logged out. Saved Puls data deleted.\n');
    return true;
}
