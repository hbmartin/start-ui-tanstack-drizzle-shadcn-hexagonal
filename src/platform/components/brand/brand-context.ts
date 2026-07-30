import {
  type ComponentType,
  createContext,
  type SVGProps,
  useContext,
} from 'react';

export type BrandMark = ComponentType<SVGProps<SVGSVGElement>>;

export type Brand = {
  /** Mark rendered by `Logo` across shells, auth screens, and home. */
  mark: BrandMark;
};

/**
 * Inversion point for product identity: `src/platform` never imports the
 * adopter zone, so the app shell injects the brand here (see
 * `src/routes/__root.tsx` and `src/app/adopter`).
 */
export const BrandContext = createContext<Brand | null>(null);

export const useBrand = () => useContext(BrandContext);
