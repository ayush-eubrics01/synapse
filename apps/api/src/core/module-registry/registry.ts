import { type Db, schema } from "@synapse/database";
import { newId } from "@synapse/shared";
import { eq, sql } from "drizzle-orm";

const { modules, moduleDependencies } = schema;

export interface ModuleRegistration {
  name: string;
  version: string;
  dependsOn: string[];
}

export class ModuleRegistry {
  constructor(private readonly db: Db) {}

  register(m: ModuleRegistration): void {
    // Modules register in arbitrary order and validate() reports unresolved dependencies, so the
    // dependency FK must not reject a not-yet-registered target. The pragma is a no-op inside a
    // transaction, hence it brackets the transaction.
    this.db.run(sql`PRAGMA foreign_keys = OFF`);
    try {
      this.write(m);
    } finally {
      this.db.run(sql`PRAGMA foreign_keys = ON`);
    }
  }

  private write(m: ModuleRegistration): void {
    this.db.transaction(
      (tx) => {
        tx.insert(modules)
          .values({ name: m.name, version: m.version })
          .onConflictDoUpdate({ target: modules.name, set: { version: m.version } })
          .run();
        tx.delete(moduleDependencies).where(eq(moduleDependencies.module, m.name)).run();
        for (const dep of new Set(m.dependsOn)) {
          tx.insert(moduleDependencies)
            .values({ id: newId(), module: m.name, dependsOn: dep })
            .run();
        }
      },
      { behavior: "immediate" },
    );
  }

  /** Throws if a dependency is not registered or the dependency graph has a cycle. */
  validate(): void {
    const names = new Set(
      this.db
        .select({ name: modules.name })
        .from(modules)
        .all()
        .map((r) => r.name),
    );
    const graph = new Map<string, string[]>();
    for (const n of names) graph.set(n, []);
    for (const d of this.db.select().from(moduleDependencies).all()) {
      if (!names.has(d.dependsOn)) {
        throw new Error(`missing dependency: ${d.module} depends on ${d.dependsOn}`);
      }
      graph.get(d.module)?.push(d.dependsOn);
    }
    const state = new Map<string, "visiting" | "done">();
    const visit = (n: string, path: string[]): void => {
      const s = state.get(n);
      if (s === "done") return;
      if (s === "visiting") {
        throw new Error(`dependency cycle: ${[...path.slice(path.indexOf(n)), n].join(" -> ")}`);
      }
      state.set(n, "visiting");
      for (const next of graph.get(n) ?? []) visit(next, [...path, n]);
      state.set(n, "done");
    };
    for (const n of names) visit(n, []);
  }

  list(): { name: string; version: string; enabled: boolean }[] {
    return this.db.select().from(modules).orderBy(modules.name).all();
  }
}
