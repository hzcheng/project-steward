'use strict';

export interface DashboardMessageHandlers {
    handleRawMessage: (message: unknown) => Promise<void>;
}

export function createDashboardMessageRouter(handlers: DashboardMessageHandlers): (message: unknown) => Promise<void> {
    return message => handlers.handleRawMessage(message);
}
