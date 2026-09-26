import { CCTUI_PLUGIN_API, type CctuiPluginModule } from '../sdk/types.ts';
import { messageActions } from './actions.ts';
import YubisashiPane from './YubisashiPane.svelte';

const plugin: CctuiPluginModule = {
	cctuiApi: CCTUI_PLUGIN_API,
	sessionPane: YubisashiPane,
	messageActions,
};

export default plugin;
