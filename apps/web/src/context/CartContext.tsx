import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CART_ITEM_QUANTITY_LIMITS, type CartDto } from "@zelora/shared";
import { ApiFailureError } from "../lib/api/client";
import { resolveCartFailure } from "../lib/cart/errors";
import { useAuth } from "./AuthContext";

/**
 * Global cart boundary shared by the header badge and the cart page.
 *
 * The cart lives server-side behind the authenticated session, so this
 * provider mirrors the API's {@link CartDto} in React state. Every mutation
 * (add/update/remove/clear) goes through the existing API client with the
 * in-memory CSRF token and adopts the authoritative cart the API returns, so
 * the header count and the cart page stay synchronized by construction.
 *
 * Quantity updates, removes and clears apply an optimistic edit first for a
 * responsive UI and revert to the pre-edit cart if the request fails.
 */
export type CartStatus = "loading" | "ready" | "signed-out";

export interface CartContextValue {
  cart: CartDto | null;
  itemCount: number;
  status: CartStatus;
  error: string | null;
  refresh: () => Promise<void>;
  addItem: (variantId: string, quantity?: number) => Promise<void>;
  updateItemQuantity: (itemId: string, quantity: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  clearCart: () => Promise<void>;
}

const CartContext = createContext<CartContextValue | null>(null);

function clampQuantity(quantity: number): number {
  return Math.min(
    CART_ITEM_QUANTITY_LIMITS.max,
    Math.max(CART_ITEM_QUANTITY_LIMITS.min, quantity),
  );
}

function withQuantity(cart: CartDto, itemId: string, quantity: number): CartDto {
  return {
    ...cart,
    items: cart.items.map((item) => (item.id === itemId ? { ...item, quantity } : item)),
  };
}

function withoutItem(cart: CartDto, itemId: string): CartDto {
  return { ...cart, items: cart.items.filter((item) => item.id !== itemId) };
}

function emptyItems(cart: CartDto): CartDto {
  return { ...cart, items: [] };
}

function sumQuantity(cart: CartDto | null): number {
  if (cart === null) {
    return 0;
  }
  return cart.items.reduce((total, item) => total + item.quantity, 0);
}

export function CartProvider({ children }: { children: ReactNode }) {
  const { api, status: authStatus } = useAuth();
  const [cart, setCart] = useState<CartDto | null>(null);
  const [status, setStatus] = useState<CartStatus>(
    authStatus === "authenticated" ? "loading" : authStatus === "loading" ? "loading" : "signed-out",
  );
  const [error, setError] = useState<string | null>(null);
  const cartRef = useRef<CartDto | null>(null);

  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const envelope = await api.getCart();
      if (!envelope.ok) {
        throw new ApiFailureError(envelope.error);
      }
      setCart(envelope.data);
    } catch (cause) {
      setError(resolveCartFailure(cause));
    }
    setStatus("ready");
  }, [api]);

  useEffect(() => {
    if (authStatus === "loading") {
      setStatus("loading");
      setCart(null);
      setError(null);
      return;
    }
    if (authStatus === "signed-out") {
      setStatus("signed-out");
      setCart(null);
      setError(null);
      return;
    }
    setStatus("loading");
    setError(null);
    void refresh();
  }, [authStatus, refresh]);

  const addItem = useCallback(
    async (variantId: string, quantity: number = 1) => {
      const envelope = await api.addCartItem({ variantId, quantity });
      if (!envelope.ok) {
        throw new ApiFailureError(envelope.error);
      }
      setCart(envelope.data);
      setError(null);
    },
    [api],
  );

  const updateItemQuantity = useCallback(
    async (itemId: string, quantity: number) => {
      const previous = cartRef.current;
      const nextQuantity = clampQuantity(quantity);
      if (previous !== null) {
        setCart(withQuantity(previous, itemId, nextQuantity));
        setError(null);
      }
      try {
        const envelope = await api.updateCartItemQuantity(itemId, { quantity: nextQuantity });
        if (!envelope.ok) {
          throw new ApiFailureError(envelope.error);
        }
        setCart(envelope.data);
      } catch (cause) {
        if (previous !== null) {
          setCart(previous);
        }
        throw cause;
      }
    },
    [api],
  );

  const removeItem = useCallback(
    async (itemId: string) => {
      const previous = cartRef.current;
      if (previous !== null) {
        setCart(withoutItem(previous, itemId));
        setError(null);
      }
      try {
        const envelope = await api.removeCartItem(itemId);
        if (!envelope.ok) {
          throw new ApiFailureError(envelope.error);
        }
        setCart(envelope.data);
      } catch (cause) {
        if (previous !== null) {
          setCart(previous);
        }
        throw cause;
      }
    },
    [api],
  );

  const clearCart = useCallback(async () => {
    const previous = cartRef.current;
    if (previous !== null) {
      setCart(emptyItems(previous));
      setError(null);
    }
    try {
      const envelope = await api.clearCart();
      if (!envelope.ok) {
        throw new ApiFailureError(envelope.error);
      }
      setCart(envelope.data);
    } catch (cause) {
      if (previous !== null) {
        setCart(previous);
      }
      throw cause;
    }
  }, [api]);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      itemCount: sumQuantity(cart),
      status,
      error,
      refresh,
      addItem,
      updateItemQuantity,
      removeItem,
      clearCart,
    }),
    [cart, status, error, refresh, addItem, updateItemQuantity, removeItem, clearCart],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (context === null) {
    throw new Error("useCart must be used within a CartProvider");
  }
  return context;
}