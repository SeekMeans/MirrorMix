/** A status check can succeed while reporting no login. Also understands earlier servers. */
export async function readAuthStatus(response: Response): Promise<{ authenticated: boolean; username: string }> {
  if (response.status === 404) return { authenticated: true, username: "" };
  const body = await response.json().catch(() => ({})) as { authenticated?: boolean; ok?: boolean; username?: string };
  return {
    authenticated: response.ok && (body.authenticated === true || (body.authenticated === undefined && body.ok === true)),
    username: typeof body.username === "string" ? body.username : "",
  };
}
