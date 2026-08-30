type Profile = Readonly<{ displayName: string }>;

export type Account = Profile;

const compatibility = { AccountId: 'legacy-account-id' };
export const { AccountId } = compatibility;

const profileAlias = { displayName: 'Legacy profile' };
export { profileAlias as 'AccountProfile' };
