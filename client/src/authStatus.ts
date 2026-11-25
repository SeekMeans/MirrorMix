/** A status check can succeed while reporting no login. Also understands earlier servers. */
export async function readAuthStatus(response: Response): Promise<{ authenticated: boolean; signedIn: boolean; passwordSet: boolean }> {
  if (response.status === 404) return { authenticated: true, signedIn: false, passwordSet: true };
  const body = await response.json().catch(() => ({})) as { authenticated?: boolean; ok?: boolean; signedIn?: boolean; passwordSet?: boolean };
  return {
    authenticated: response.ok && (body.authenticated === true || (body.authenticated === undefined && body.ok === true)),
    // Only a visit through the public address signs in; on this PC there is nothing to sign out of.
    signedIn: body.signedIn === true,
    passwordSet: body.passwordSet !== false,
  };
}
