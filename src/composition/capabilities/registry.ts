import { authCapabilityManifest } from '@/modules/auth/manifest';
import { bookCapabilityManifest } from '@/modules/book/manifest';
import { emailCapabilityManifest } from '@/modules/email/manifest';
import { genreCapabilityManifest } from '@/modules/genre/manifest';
import {
  defineCapabilityRegistry,
  selectDeclaredCapabilitiesForPreset,
  type CapabilityPreset,
} from '@/modules/kernel/manifest';
import { profileCapabilityManifest } from '@/modules/profile/manifest';
import { userCapabilityManifest } from '@/modules/user/manifest';

export const capabilityRegistry = defineCapabilityRegistry([
  emailCapabilityManifest,
  authCapabilityManifest,
  profileCapabilityManifest,
  userCapabilityManifest,
  genreCapabilityManifest,
  bookCapabilityManifest,
] as const);

export const getDeclaredCapabilitiesForPreset = (preset: CapabilityPreset) =>
  selectDeclaredCapabilitiesForPreset(capabilityRegistry, preset);
