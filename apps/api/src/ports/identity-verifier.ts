/** The claims kb-chat keeps from a verified Google ID token. */
export interface VerifiedIdentity {
  /** Google's stable account id: the principal (ADR 0008). */
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly picture: string | null;
}

/** Verifies the credential the web got from Google Identity Services. */
export interface IdentityVerifierPort {
  /** Throws AppError UNAUTHENTICATED (bad token) or AUTH_UNAVAILABLE (keys unreachable). */
  verify(credential: string): Promise<VerifiedIdentity>;
}
