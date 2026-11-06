import { Hono } from "hono";
import type { Container } from "../container";
import {
  checkSettingValue,
  USER_EDITABLE_SETTINGS,
  type UserEditableKey,
} from "../core/config/settings";

const EDITABLE: ReadonlySet<string> = new Set(USER_EDITABLE_SETTINGS);

function values(c: Container): Record<UserEditableKey, unknown> {
  return Object.fromEntries(USER_EDITABLE_SETTINGS.map((k) => [k, c.settings.get(k)])) as Record<
    UserEditableKey,
    unknown
  >;
}

const invalid = { error: "invalid_setting" } as const;

/** C8: only the Phase 10b keys are exposed; internal and test-only keys are not editable here. */
export function settingsRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/settings", (ctx) => ctx.json(values(c)));
  app.put("/api/settings", async (ctx) => {
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(invalid, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return ctx.json(invalid, 400);
    }
    const entries = Object.entries(body);
    const parsed: [UserEditableKey, unknown][] = [];
    for (const [key, value] of entries) {
      if (!EDITABLE.has(key)) return ctx.json(invalid, 400);
      const r = checkSettingValue(key as UserEditableKey, value);
      if (!r.ok) return ctx.json(invalid, 400);
      parsed.push([key as UserEditableKey, r.value]);
    }
    if (parsed.length > 0) {
      c.db.transaction(
        (tx) => {
          for (const [k, v] of parsed) c.settings.setIn(tx, k, v as never);
          c.audit.record(tx, {
            actor: "user",
            module: "settings",
            action: "settings.updated",
            result: "ok",
            details: { keys: parsed.map(([k]) => k) },
          });
        },
        { behavior: "immediate" },
      );
    }
    return ctx.json(values(c));
  });
  return app;
}
