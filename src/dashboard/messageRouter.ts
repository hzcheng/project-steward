'use strict';

export type DashboardMessage = { type?: unknown; [key: string]: unknown };
export type DashboardMessageHandlerResult = void | Promise<void> | PromiseLike<void>;
export type DashboardMessageHandler = (message: DashboardMessage) => DashboardMessageHandlerResult;
export type DashboardAiSessionMessageHandler = (message: DashboardMessage, providerId: string | null) => DashboardMessageHandlerResult;

export interface DashboardMessageHandlers {
    handlers: Record<string, DashboardMessageHandler>;
    getAiSessionProviderIds?: () => readonly string[];
    resumeAiSession?: DashboardAiSessionMessageHandler;
    archiveAiSession?: DashboardAiSessionMessageHandler;
}

export function createDashboardMessageRouter(handlers: DashboardMessageHandlers): (message: unknown) => Promise<void> {
    return async message => {
        if (!isDashboardMessage(message)) {
            return;
        }

        const messageType = String(message.type || '');
        if (!messageType) {
            return;
        }

        const resumeProviderId = getAiSessionProviderIdFromMessage(message, 'resume', handlers.getAiSessionProviderIds);
        if (resumeProviderId !== undefined) {
            if (handlers.resumeAiSession) {
                await handlers.resumeAiSession(message, resumeProviderId);
            }
            return;
        }

        const archiveProviderId = getAiSessionProviderIdFromMessage(message, 'archive', handlers.getAiSessionProviderIds);
        if (archiveProviderId !== undefined) {
            if (handlers.archiveAiSession) {
                await handlers.archiveAiSession(message, archiveProviderId);
            }
            return;
        }

        const handler = handlers.handlers[messageType];
        if (handler) {
            await handler(message);
        }
    };
}

function isDashboardMessage(message: unknown): message is DashboardMessage {
    return Boolean(message) && typeof message === 'object';
}

function getAiSessionProviderIdFromMessage(
    message: DashboardMessage,
    action: 'resume' | 'archive',
    getProviderIds: (() => readonly string[]) | undefined
): string | null | undefined {
    const messageType = String(message.type || '');
    if (messageType === `${action}-ai-session`) {
        if (typeof message.provider !== 'string') {
            return null;
        }
        if (getProviderIds && getProviderIds().indexOf(message.provider) < 0) {
            return null;
        }
        return message.provider;
    }

    if (!getProviderIds) {
        return undefined;
    }

    for (let providerId of getProviderIds()) {
        if (messageType === `${action}-${providerId}-session`) {
            return providerId;
        }
    }

    return undefined;
}
