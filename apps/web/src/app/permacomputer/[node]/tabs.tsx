'use client';

/**
 * The node page's tabs, one module each under `_tabs/` (underscore: private
 * to the App Router, never a route). This file re-exports them so
 * `./tabs` keeps every name it always had.
 */
export { SettingsTab } from './_tabs/settings';
export { BootstrapTab } from './_tabs/bootstrap';
export { ProcessesTab } from './_tabs/processes';
export { OverviewTab } from './_tabs/overview';
export { HarnessesTab } from './_tabs/harnesses';
export { ContainersTab, orderContainers } from './_tabs/containers';
export { VirtualMachinesSection } from './_tabs/virtual-machines';
export { Section, containerStatus, NULL_TOOLTIP, HIDDEN_WRAPPER_STYLE } from './_tabs/shared';
