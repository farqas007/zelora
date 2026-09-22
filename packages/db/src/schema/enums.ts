/**
 * Single source of truth for every status/value used by the schema.
 *
 * SQLite has no native enum type; these arrays are used both as TypeScript
 * unions and as Drizzle `text({ enum })` values, which generate real
 * `CHECK (col IN (...))` constraints in the SQL migration. Later API layers
 * re-export these from `@zelora/shared` so the browser contract shares the
 * same vocabulary without importing the database package.
 */

export const USER_ROLES = ["customer", "seller", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "suspended", "deleted"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SELLER_PROFILE_STATUSES = ["pending", "active", "suspended", "rejected"] as const;
export type SellerProfileStatus = (typeof SELLER_PROFILE_STATUSES)[number];

export const STORE_STATUSES = ["draft", "active", "inactive", "closed"] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export const CATEGORY_STATUSES = ["active", "inactive"] as const;
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];

export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_VARIANT_STATUSES = ["draft", "active", "inactive"] as const;
export type ProductVariantStatus = (typeof PRODUCT_VARIANT_STATUSES)[number];

export const ORDER_STATUSES = ["pending", "confirmed", "processing", "completed", "cancelled", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_ITEM_STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled", "refunded"] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

export const ADDRESS_TYPES = ["shipping", "billing"] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

/** The same allowed values apply to the `order_addresses.kind` column. */
export const ORDER_ADDRESS_KINDS = ADDRESS_TYPES;
export type OrderAddressKind = AddressType;