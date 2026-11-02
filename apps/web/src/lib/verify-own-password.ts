// What: The Academy override step-up. Better Auth checks the signed-in user's own password against
// the request session. Only Better Auth's invalid-password error means "wrong password"; any other
// error (auth or database outage) is rethrown so the API maps it to STORAGE_ERROR, not a failure.

type VerifyPasswordApi = Readonly<{
  verifyPassword: (input: {
    body: { password: string };
    headers: Headers;
  }) => Promise<{ status?: boolean } | null | undefined>;
}>;

const isInvalidPasswordError = (error: unknown): boolean => {
  if (error === null || typeof error !== "object") return false;
  const body = (error as { body?: unknown }).body;
  return (
    body !== null &&
    typeof body === "object" &&
    (body as { code?: unknown }).code === "INVALID_PASSWORD"
  );
};

export const verifyOwnPassword = async (
  api: VerifyPasswordApi,
  headers: Headers,
  password: string
): Promise<boolean> => {
  try {
    const result = await api.verifyPassword({ body: { password }, headers });
    return result?.status === true;
  } catch (error) {
    if (isInvalidPasswordError(error)) return false;
    throw error;
  }
};
