import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, auditLog, organizations, refreshTokens, users } from "../db/schema.js";
import type {
  PlatformApplication,
  PlatformDailySeries,
  PlatformOrganization,
  PlatformRepository,
  PlatformSecuritySummary,
  PlatformUser,
} from "./types.js";

/**
 * Platform-owner reads: the listings and the aggregate security numbers behind
 * `/v1/admin/platform/*`.
 *
 * One interface rather than six extra methods spread across the user,
 * organization, application and audit repositories, and the reason is that these
 * reads share a property none of the others have: **they are unscoped by
 * design.** Every other query in the data layer is filtered by an organization,
 * which is the tenancy guarantee this codebase is built around. These deliberately
 * are not, because a platform owner is asking about the whole installation. That
 * is a different kind of query, and grouping it under one name makes it obvious
 * in review which queries are exempt from tenancy and why.
 *
 * It also means the two places that could get it wrong are the two places a
 * reader will look. `listUsers` projects an explicit column list rather than
 * selecting `*` because a password hash must not reach a response body; that
 * projection is the reason this method cannot be `userRepository.listAll()`.
 */
export class DrizzlePlatformRepository implements PlatformRepository {
  /**
   * Every user, with the columns a platform owner is allowed to see.
   *
   * The projection is explicit and is the security control: `passwordHash` is not
   * in it, and neither is anything else that has no business in an API response.
   * Adding a column to `users` therefore cannot leak by default — it has to be
   * added here on purpose.
   */
  async listUsers(): Promise<PlatformUser[]> {
    return db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        name: users.name,
        role: users.role,
        isActive: users.isActive,
        accountReviewRequired: users.accountReviewRequired,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.createdAt);
  }

  async listOrganizations(): Promise<PlatformOrganization[]> {
    return db.select().from(organizations).orderBy(organizations.createdAt);
  }

  async listApplications(): Promise<PlatformApplication[]> {
    return db
      .select({
        id: applications.id,
        orgId: applications.orgId,
        clientId: applications.clientId,
        name: applications.name,
        redirectUris: applications.redirectUris,
        allowedOrigins: applications.allowedOrigins,
        allowedIps: applications.allowedIps,
        blockedIps: applications.blockedIps,
        branding: applications.branding,
        isActive: applications.isActive,
        createdAt: applications.createdAt,
        updatedAt: applications.updatedAt,
      })
      .from(applications)
      .orderBy(applications.createdAt);
  }

  /**
   * One row per day of audit activity, for the platform activity chart.
   *
   * The aggregation is in SQL rather than in JavaScript on purpose: the audit log
   * is the largest table in the system, and `since` is caller-supplied, so
   * reading the rows to count them would let a wide window become a
   * memory-exhaustion vector on an endpoint only a platform owner can reach.
   */
  async dailySeries(since: Date): Promise<PlatformDailySeries[]> {
    // `date(...)` and not `date_trunc('day', ... AT TIME ZONE 'UTC')::date`, which
    // is what a UTC-correct version would be. The original expression buckets on
    // the *session* time zone, and swapping it would silently move every day
    // boundary in the chart for a deployment whose database is not on UTC. It is
    // not obviously right, and it is not this refactor's business to change it.
    // Carried over exactly; the behaviour is pinned by the platform suite.
    const dateSql = sql<string>`date(${auditLog.createdAt})`;
    return db
      .select({
        date: dateSql,
        logins: sql<number>`count(*) filter (where ${auditLog.event} = 'user_login')`.mapWith(Number),
        failedLogins: sql<number>`count(*) filter (where ${auditLog.event} = 'user_login_failed')`.mapWith(Number),
        signups: sql<number>`count(*) filter (where ${auditLog.event} = 'user_registered')`.mapWith(Number),
        dau: sql<number>`count(distinct ${auditLog.userId}) filter (where ${auditLog.event} = 'user_login')`.mapWith(Number),
      })
      .from(auditLog)
      .where(gte(auditLog.createdAt, since))
      .groupBy(dateSql)
      .orderBy(dateSql);
  }

  /**
   * The security summary: 24-hour login counts, live sessions, MFA adoption, and
   * the two most recent login events of each kind.
   */
  async securitySummary(now: Date): Promise<PlatformSecuritySummary> {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const recentColumns = {
      id: auditLog.id,
      event: auditLog.event,
      userId: auditLog.userId,
      ipAddress: auditLog.ipAddress,
      userAgent: auditLog.userAgent,
      createdAt: auditLog.createdAt,
    };

    const [
      [logins],
      [failedLogins],
      [activeSessions],
      [mfaUsers],
      [totalUsers],
      recentLogins,
      [newDeviceEvents],
      recentFailedLogins,
    ] = await Promise.all([
      db
        .select({ total: count() })
        .from(auditLog)
        .where(and(eq(auditLog.event, "user_login"), gte(auditLog.createdAt, since))),
      db
        .select({ total: count() })
        .from(auditLog)
        .where(and(eq(auditLog.event, "user_login_failed"), gte(auditLog.createdAt, since))),
      db
        .select({ total: count() })
        .from(refreshTokens)
        .where(and(isNull(refreshTokens.revokedAt), gte(refreshTokens.expiresAt, now))),
      db.select({ total: count() }).from(users).where(eq(users.totpEnabled, true)),
      db.select({ total: count() }).from(users),
      db
        .select(recentColumns)
        .from(auditLog)
        .where(eq(auditLog.event, "user_login"))
        .orderBy(desc(auditLog.createdAt))
        .limit(10),
      db
        .select({ total: count() })
        .from(auditLog)
        .where(and(eq(auditLog.event, "new_device_detected"), gte(auditLog.createdAt, since))),
      db
        .select(recentColumns)
        .from(auditLog)
        .where(and(eq(auditLog.event, "user_login_failed"), gte(auditLog.createdAt, since)))
        .orderBy(desc(auditLog.createdAt))
        .limit(10),
    ]);

    return {
      logins: logins.total,
      failedLogins: failedLogins.total,
      activeSessions: activeSessions.total,
      mfaUsers: mfaUsers.total,
      totalUsers: totalUsers.total,
      newDeviceEvents: newDeviceEvents.total,
      recentLogins,
      recentFailedLogins,
    };
  }
}
