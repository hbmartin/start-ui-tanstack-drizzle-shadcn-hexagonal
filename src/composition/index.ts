export {
  __resetKernelComposition,
  getKernel,
  type KernelOverrides,
} from './kernel';

import { getKernel, type KernelOverrides } from './kernel';

export type ServicesOverrides = {
  kernel?: KernelOverrides;
};

export function getServices(overrides?: ServicesOverrides) {
  return {
    kernel: getKernel(overrides?.kernel),
  } as const;
}
