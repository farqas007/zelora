import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  PENDING_SELLERS_PAGE_LIMITS,
  type PendingSellerDto,
} from "@zelora/shared";
import { LoadingState } from "../components/LoadingState";
import { PageShell } from "../components/PageShell";
import { useAuth } from "../context/AuthContext";
import { resolveApiFailure } from "../lib/auth/errors";

/**
 * Admin review queue for pending seller applications.
 *
 * The page renders exactly the fields `PendingSellerDto` carries — profile,
 * owner and first store — and never derives anything the API did not send. The
 * one value it computes is the id a decision is addressed to: the admin routes
 * take the *owning user's* id (UUIDv7), not the profile id, so every decision
 * is sent as `seller.user.id`.
 *
 * ### The queue is the server's list
 *
 * A decision does not splice the row out locally. Both actions end with a fresh
 * `listPendingSellers`, because the server decides what leaves the queue (an
 * already-rejected profile is an idempotent success, a raced activation moves a
 * row to a different state) and a locally-filtered list could contradict it. The
 * same re-read also keeps the "Load more" cursor honest, since a removal shifts
 * every keyset position after it.
 *
 * A decision that lands while the refresh fails is reported as a *refresh*
 * failure rather than a success, because the row still on screen is stale.
 */

/** Which decision, if any, is in flight. One value, so decisions cannot overlap. */
type PendingDecision =
  | { kind: "none" }
  | { kind: "activate"; userId: string }
  | { kind: "reject"; userId: string };

const NO_PENDING: PendingDecision = { kind: "none" };

/** True while any decision is running; every control is disabled on it. */
function isBusy(pending: PendingDecision): boolean {
  return pending.kind !== "none";
}

/** The outcome of one decision request, before the queue is re-read. */
type DecisionOutcome = { ok: true; notice: string } | { ok: false; message: string };

/** The outcome of one queue read. It carries the message instead of setting it,
 *  so a caller decides whether a failed read is a load error or the tail of a
 *  decision that did land. */
type QueueOutcome = { ok: true } | { ok: false; message: string };

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

export function AdminSellersPage() {
  const { api, user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [sellers, setSellers] = useState<PendingSellerDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pending, setPending] = useState<PendingDecision>(NO_PENDING);
  // Mirrors `pending`, written synchronously. React does not commit between two
  // discrete events, so the state alone would almost always do; this keeps the
  // overlap guard from depending on that flushing discipline holding.
  const pendingRef = useRef<PendingDecision>(NO_PENDING);
  const [notice, setNotice] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  /**
   * Read the first page of the queue.
   *
   * Reports rather than renders: the caller decides what a failed read means. A
   * first load shows it as a load error, while a read that follows a *successful*
   * decision has to stay quiet about claiming success over a stale list.
   */
  async function loadFirstPage(): Promise<QueueOutcome> {
    const envelope = await api.listPendingSellers({
      limit: PENDING_SELLERS_PAGE_LIMITS.default,
    });
    if (!envelope.ok) {
      return { ok: false, message: envelope.error.message };
    }
    setSellers(envelope.data.items);
    setNextCursor(envelope.data.nextCursor);
    return { ok: true };
  }

  useEffect(() => {
    if (!isAdmin) {
      return;
    }

    let active = true;
    setLoading(true);
    setQueueError(null);

    void (async () => {
      try {
        const outcome = await loadFirstPage();
        if (active) {
          setQueueError(outcome.ok ? null : outcome.message);
        }
      } catch (cause) {
        if (active) {
          setQueueError(resolveApiFailure(cause).message);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [api, isAdmin]);

  async function onLoadMore(): Promise<void> {
    if (nextCursor === null || loadingMore || loading || !isAdmin) {
      return;
    }
    setLoadingMore(true);
    setQueueError(null);
    try {
      const envelope = await api.listPendingSellers({
        limit: PENDING_SELLERS_PAGE_LIMITS.default,
        cursor: nextCursor,
      });
      if (!envelope.ok) {
        setQueueError(envelope.error.message);
        return;
      }
      setSellers((current) => [...current, ...envelope.data.items]);
      setNextCursor(envelope.data.nextCursor);
    } catch (cause) {
      setQueueError(resolveApiFailure(cause).message);
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Run one decision, guarding against overlap and reporting its failure.
   *
   * The guard reads the ref rather than `pending`, so two clicks landing before
   * React re-renders cannot both reach the API and act on the same application
   * twice.
   */
  async function runDecision(
    decision: Exclude<PendingDecision, { kind: "none" }>,
    send: () => Promise<DecisionOutcome>,
  ): Promise<void> {
    if (isBusy(pendingRef.current)) {
      return;
    }
    pendingRef.current = decision;
    setDecisionError(null);
    setNotice(null);
    setPending(decision);
    try {
      const outcome = await send();
      if (!outcome.ok) {
        setDecisionError(outcome.message);
        return;
      }
      const refreshed = await loadFirstPage();
      if (!refreshed.ok) {
        // The decision landed, so this is not a failure of the decision — but
        // the row still on screen is stale, and a green confirmation beside a
        // stale queue would be claiming more than the page knows.
        setDecisionError(
          `The decision was applied, but the pending list could not be refreshed. ${refreshed.message}`,
        );
        return;
      }
      setQueueError(null);
      setNotice(outcome.notice);
    } catch (cause) {
      setDecisionError(resolveApiFailure(cause).message);
    } finally {
      pendingRef.current = NO_PENDING;
      setPending(NO_PENDING);
    }
  }

  function onActivate(seller: PendingSellerDto): void {
    void runDecision({ kind: "activate", userId: seller.user.id }, async () => {
      const envelope = await api.activateSeller(seller.user.id);
      return envelope.ok
        ? { ok: true, notice: `Activated ${seller.sellerProfile.displayName}.` }
        : { ok: false, message: envelope.error.message };
    });
  }

  function onReject(seller: PendingSellerDto): void {
    void runDecision({ kind: "reject", userId: seller.user.id }, async () => {
      const envelope = await api.rejectSeller(seller.user.id);
      return envelope.ok
        ? { ok: true, notice: `Rejected ${seller.sellerProfile.displayName}.` }
        : { ok: false, message: envelope.error.message };
    });
  }

  const busy = isBusy(pending);

  return (
    <PageShell title="Admin · Seller Management">
      <section className="seller-products" aria-labelledby="pending-sellers-heading">
        <div className="section-heading">
          <div>
            <h2 id="pending-sellers-heading">Pending seller applications</h2>
            <p className="muted">
              Review each application and activate or reject it. Activation promotes the
              owner's seller profile and their first store.
            </p>
          </div>
        </div>

        {decisionError !== null && (
          <p className="form-alert" role="alert">
            {decisionError}
          </p>
        )}

        {notice !== null && (
          <p className="form-success" role="status">
            {notice}
          </p>
        )}

        {queueError !== null && (
          <p className="form-alert" role="alert">
            {queueError}
          </p>
        )}

        {loading && sellers.length === 0 && <LoadingState label="Loading pending sellers…" />}

        {!loading && queueError === null && sellers.length === 0 && (
          <p className="muted">There are no pending seller applications.</p>
        )}

        {sellers.length > 0 && (
          <ul className="seller-product-list">
            {sellers.map((seller) => {
              const running =
                pending.kind !== "none" && pending.userId === seller.user.id;
              return (
                <li className="user-card admin-seller" key={seller.sellerProfile.id}>
                  <div className="section-heading">
                    <div>
                      <h3>{seller.sellerProfile.displayName}</h3>
                      <p className="muted">/{seller.sellerProfile.slug}</p>
                    </div>
                    <span className="badge">{seller.sellerProfile.status}</span>
                  </div>

                  <dl className="seller-product-facts">
                    <div>
                      <dt>Owner</dt>
                      <dd>
                        {seller.user.name} · {seller.user.email}
                      </dd>
                    </div>
                    <div>
                      <dt>First store</dt>
                      <dd>
                        {seller.store.name} /{seller.store.slug}
                      </dd>
                    </div>
                    <div>
                      <dt>Store status</dt>
                      <dd>{seller.store.status}</dd>
                    </div>
                    <div>
                      <dt>Applied</dt>
                      <dd>{formatDate(seller.sellerProfile.createdAt)}</dd>
                    </div>
                  </dl>

                  {seller.store.description !== null && (
                    <p className="admin-seller-description">{seller.store.description}</p>
                  )}

                  <div className="admin-seller-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => onActivate(seller)}
                      disabled={busy}
                      aria-label={`Activate ${seller.sellerProfile.displayName}`}
                    >
                      {running && pending.kind === "activate" ? "Activating…" : "Activate"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onReject(seller)}
                      disabled={busy}
                      aria-label={`Reject ${seller.sellerProfile.displayName}`}
                    >
                      {running && pending.kind === "reject" ? "Rejecting…" : "Reject"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {nextCursor !== null && (
          <div className="pagination-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void onLoadMore()}
              disabled={loadingMore || loading}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>

      <ul className="dashboard-actions">
        <li>
          <Link to="/dashboard">Back to dashboard</Link>
        </li>
      </ul>
    </PageShell>
  );
}
