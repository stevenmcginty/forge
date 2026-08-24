---
name: supabase-data-layer
description: Data-layer patterns for Supabase apps — cache-first reads, optimistic/offline writes, pre-aggregation in Postgres, query hygiene, index-friendly RLS, and non-blocking auth. Use when building or auditing any screen that reads or writes Supabase, when an app "feels slow" against Supabase, when adding a dashboard/aggregate, when writing or reviewing RLS policies, or when the user asks to audit a project against Supabase best practice.
metadata:
  tags: supabase, postgres, rls, tanstack-query, caching, offline, realtime, performance, multi-tenant
---

## What this skill is for

Supabase gives you Postgres, Realtime and auth, but **no client-side cache and no local-first writes**. Those are the two things that make an app feel instant, so you build them yourself. Wire it once and every screen inherits it.

Reference stack: `@supabase/supabase-js`, `@tanstack/react-query`, `@tanstack/react-query-persist-client`, `idb-keyval`.

> **Non-React codebases:** the code below is React, but the five principles are framework-agnostic — persist a cache, paint from it, write optimistically, aggregate in Postgres, keep queries and RLS lean. In a vanilla-JS app the equivalents are an IndexedDB/localStorage cache read on boot, a mutation queue, and the same SQL-side rules. Audit against the principles, not the imports.

---

## 1. Cache-first reads

### Persist the query cache to IndexedDB

This is the piece that makes a cold launch paint instantly. Without it, every app open is a network wait.

```ts
// src/lib/queryClient.ts
import { QueryClient } from '@tanstack/react-query';
import { get, set, del } from 'idb-keyval';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,           // don't refetch on every mount
      gcTime: 1000 * 60 * 60 * 24, // keep in cache for a day
      refetchOnWindowFocus: true,
      retry: 2,
    },
  },
});

export const persister: Persister = {
  persistClient: (client) => set('rq-cache', client),
  restoreClient: () => get<PersistedClient>('rq-cache'),
  removeClient: () => del('rq-cache'),
};
```

```tsx
// src/main.tsx
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';

<PersistQueryClientProvider
  client={queryClient}
  persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 }}
>
  <App />
</PersistQueryClientProvider>
```

Now `useQuery` returns cached data synchronously on mount, with `isFetching` true while it revalidates in the background. That's your cache-first paint.

```ts
const { data, isFetching, isPending } = useQuery({
  queryKey: ['orders', tenantId, 'open'],
  queryFn: async () => {
    const { data, error } = await supabase
      .from('orders')
      .select('id, status, total, created_at, order_items(id, name, qty)')
      .eq('tenant_id', tenantId)
      .eq('status', 'open')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  },
});
```

Render on `data`. Use `isPending` (no cached data at all) to decide skeletons — **not** `isFetching`, which is true on every background revalidate and would flash skeletons over content the user is already reading.

### Query keys are the cache contract

Use a consistent, hierarchical shape: `['orders', tenantId, filter]`. **Multi-tenant apps must include the tenant id in every key**, or a tenant switch will serve the previous tenant's cached rows.

### Realtime keeps the cache warm

Postgres Changes push updates into the query cache so screens stay live without polling:

```ts
useEffect(() => {
  const channel = supabase
    .channel(`orders:${tenantId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'orders', filter: `tenant_id=eq.${tenantId}` },
      () => queryClient.invalidateQueries({ queryKey: ['orders', tenantId] }),
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}, [tenantId]);
```

Invalidating is simpler and safer than patching rows in place. If a table changes very frequently, patch with `setQueryData` instead to avoid a refetch storm.

Realtime needs the table added to the `supabase_realtime` publication, and RLS applies to the stream — a client only receives rows it's allowed to read.

### Prefetch on intent

```tsx
<Link
  to={`/orders/${id}`}
  onPointerDown={() => {
    queryClient.prefetchQuery({ queryKey: ['order', id], queryFn: () => fetchOrder(id) });
    import('./routes/OrderDetail');
  }}
>
```

---

## 2. Optimistic writes

Firestore does this for free; here it's explicit. The pattern is always the same four callbacks:

```ts
const completeOrder = useMutation({
  mutationFn: async (id: string) => {
    const { error } = await supabase.from('orders').update({ status: 'complete' }).eq('id', id);
    if (error) throw error;
  },
  onMutate: async (id) => {
    const key = ['orders', tenantId, 'open'];
    await queryClient.cancelQueries({ queryKey: key });
    const previous = queryClient.getQueryData<Order[]>(key);
    queryClient.setQueryData<Order[]>(key, (old) =>
      old?.map((o) => (o.id === id ? { ...o, status: 'complete' } : o)),
    );
    return { previous, key };
  },
  onError: (_err, _id, ctx) => {
    if (ctx) queryClient.setQueryData(ctx.key, ctx.previous);
    toast('Could not save — tap to retry');
  },
  onSettled: (_d, _e, _id, ctx) => {
    if (ctx) queryClient.invalidateQueries({ queryKey: ctx.key });
  },
});
```

Call `completeOrder.mutate(id)` — never `mutateAsync` with an `await` that gates rendering. Don't disable the button while it's in flight; the row has already moved.

For inserts that need an id before the server responds, generate a UUID client-side (`crypto.randomUUID()`) and use it as the primary key. That keeps the optimistic row stable and makes the write idempotent on retry.

### Offline writes

TanStack Query pauses mutations when offline and resumes on reconnect if you set up `onlineManager` and a mutation persister. Worth doing for anything a user might tap in a basement or a busy kitchen with poor wifi.

---

## 3. Pre-aggregate in Postgres

Never aggregate large tables in the client, and avoid ad-hoc `count`/`sum` queries on a hot dashboard path.

**Option A — rollup table maintained by trigger.** Best when the dashboard must be live to the second:

```sql
create table daily_rollups (
  tenant_id uuid not null,
  day date not null,
  takings numeric default 0,
  txn_count int default 0,
  primary key (tenant_id, day)
);
```

A trigger on `orders` bumps the row on insert/update. The dashboard reads one row.

**Option B — materialised view refreshed on a schedule.** Best for heavier analytics where a few minutes of lag is fine:

```sql
create materialized view site_performance as
  select tenant_id, date_trunc('day', created_at) as day,
         sum(total) as takings, count(*) as txns, avg(total) as avg_basket
  from orders group by 1, 2;

create unique index on site_performance (tenant_id, day);

-- refresh via pg_cron:
select cron.schedule('refresh-perf', '*/5 * * * *',
  $$refresh materialized view concurrently site_performance$$);
```

**Option C — an RPC function** for anything that needs parameters, called with `supabase.rpc('get_dashboard', { p_tenant: id })`. One round trip, one result.

---

## 4. Query hygiene that shows up as speed

- **Select columns explicitly.** `select('*')` on a wide table with a JSONB column is a common cause of a slow-feeling list.
- **Use embedded selects** (`select('*, order_items(*)')`) to get related rows in one request instead of firing a query per component.
- **Index every column you filter or order on**, especially `tenant_id` and `created_at`.
- **Make RLS policies index-friendly.** Wrap auth calls in a subselect so Postgres evaluates them once per query rather than once per row:

```sql
-- Fast
using (tenant_id = (select auth.uid()))
-- Slow at scale
using (tenant_id = auth.uid())
```

RLS is the single most common source of mystery slowness in Supabase apps. **If a query is slow, check the policy before blaming the client.**

- **Keyset pagination** over `range()` offsets on long lists — `.gt('created_at', cursor).limit(50)` stays fast as the table grows.

---

## 5. Auth without a blocking wait

Don't render a blank screen while the session restores. `supabase.auth.getSession()` reads from local storage synchronously enough to paint, and `onAuthStateChange` corrects afterwards. Treat the last known session as cache: show the app shell immediately, redirect only if the session genuinely resolves as absent.

On sign-out, clear the persisted query cache (`persister.removeClient()`) or the next user will briefly see the previous one's data.

---

## Supabase-specific checklist

- [ ] Query cache persisted to IndexedDB and restoring on cold launch
- [ ] Skeletons keyed off `isPending`, not `isFetching`
- [ ] Tenant id present in every query key
- [ ] Realtime subscribed and invalidating the right keys
- [ ] Every mutation has the full `onMutate`/`onError`/`onSettled` trio
- [ ] Dashboard numbers come from a rollup table, view, or RPC
- [ ] No `select('*')` on list screens
- [ ] RLS policies use `(select auth.uid())`
- [ ] Indexes on all filtered and ordered columns
- [ ] Query cache cleared on sign-out
