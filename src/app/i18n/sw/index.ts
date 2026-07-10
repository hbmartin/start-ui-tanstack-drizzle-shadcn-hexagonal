import buildInfo from './build-info.json' with { type: 'json' };
import common from './common.json' with { type: 'json' };
import components from './components.json' with { type: 'json' };
import layout from './layout.json' with { type: 'json' };

export default {
  buildInfo,
  common,
  components,
  layout,
} as const;
