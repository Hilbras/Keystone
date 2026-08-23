export interface FriendlyError {
  message: string;
  action?: string;
}

export function parseError(err: unknown): FriendlyError {
  const text = err instanceof Error ? err.message : String(err);
  const lower = text.toLowerCase();

  if (lower.includes("unauthorized") || lower.includes("invalid token") || text.includes("401")) {
    return {
      message: "You are not signed in or your session has expired.",
      action: "Sign in again",
    };
  }

  if (lower.includes("forbidden") || text.includes("403")) {
    return {
      message: "You do not have permission to do that.",
      action: "Contact an administrator",
    };
  }

  if (lower.includes("cors") || lower.includes("not allowed") || lower.includes("blocked")) {
    return {
      message: "This website is not allowed to talk to Keystone.",
      action: "Add the origin to Allowed Origins",
    };
  }

  if (lower.includes("relation") && lower.includes("does not exist")) {
    return {
      message: "The database is not ready. Migrations may be missing.",
      action: "Run database migrations",
    };
  }

  if (lower.includes("econnrefused") || lower.includes("connect") || lower.includes("database")) {
    return {
      message: "Keystone cannot reach the database.",
      action: "Check DATABASE_URL and make sure PostgreSQL is running",
    };
  }

  if (lower.includes("setup token")) {
    return {
      message: "The setup token is missing or has expired.",
      action: "Copy the token from the server logs",
    };
  }

  if (lower.includes("already exists")) {
    return {
      message: "An item with that name or email already exists.",
      action: "Use a different value",
    };
  }

  if (lower.includes("invalid") && lower.includes("credentials")) {
    return {
      message: "Email or password is incorrect.",
      action: "Try again or reset your password",
    };
  }

  return {
    message: text,
  };
}
