import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { Permission, PhiProfile } from '@bnp/shared';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'requiredPermissions';
export const Permissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const PHI_SCREEN_KEY = 'phiScreen';

export interface PhiScreenSpec {
  /** Body fields to screen. */
  body?: string[];
  /** Query-string parameters to screen. */
  query?: string[];
  /** Defaults to the strict FREE_TEXT profile. */
  profile?: PhiProfile;
}

/**
 * Marks the fields on a route that must be screened for patient identifiers
 * before anything is stored or forwarded. Read by `PhiScreenGuard`.
 *
 * Listing the fields at the route rather than inferring them is the point: a
 * new endpoint that takes free text is missing this line in a way a reviewer
 * can see, whereas a global rule with an opt-out list hides the same mistake.
 */
export const ScreenForPhi = (spec: PhiScreenSpec) =>
  SetMetadata(PHI_SCREEN_KEY, spec);

export interface AuthenticatedUser {
  userId: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: string[];
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser =>
    ctx.switchToHttp().getRequest().user,
);
