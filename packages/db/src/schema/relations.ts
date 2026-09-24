import { relations } from "drizzle-orm";
import { addresses } from "./addresses";
import { authSessions } from "./auth";
import { cartItems, carts } from "./cart";
import { categories, inventory, productImages, products, productVariants } from "./catalog";
import { sellerProfiles, stores, users } from "./identities";
import { orderAddresses, orderItems, orders } from "./orders";

/**
 * Relation map so `db.query.*` can be used by later phases. Pure metadata —
 * no SQL, no effect on migrations.
 */
export const usersRelations = relations(users, ({ many, one }) => ({
  sellerProfile: one(sellerProfiles, { fields: [users.id], references: [sellerProfiles.userId] }),
  addresses: many(addresses),
  orders: many(orders),
  sessions: many(authSessions),
  carts: many(carts),
}));

export const authSessionsRelations = relations(authSessions, ({ one }) => ({
  user: one(users, { fields: [authSessions.userId], references: [users.id] }),
}));

export const sellerProfilesRelations = relations(sellerProfiles, ({ many, one }) => ({
  user: one(users, { fields: [sellerProfiles.userId], references: [users.id] }),
  stores: many(stores),
}));

export const storesRelations = relations(stores, ({ many, one }) => ({
  sellerProfile: one(sellerProfiles, { fields: [stores.sellerProfileId], references: [sellerProfiles.id] }),
  products: many(products),
  orderItems: many(orderItems),
}));

export const categoriesRelations = relations(categories, ({ many, one }) => ({
  parent: one(categories, { fields: [categories.parentId], references: [categories.id] }),
  children: many(categories),
  products: many(products),
}));

export const productsRelations = relations(products, ({ many, one }) => ({
  store: one(stores, { fields: [products.storeId], references: [stores.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  images: many(productImages),
  variants: many(productVariants),
}));

export const productVariantsRelations = relations(productVariants, ({ many, one }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
  inventory: one(inventory, { fields: [productVariants.id], references: [inventory.variantId] }),
  cartItems: many(cartItems),
}));

export const cartsRelations = relations(carts, ({ many, one }) => ({
  user: one(users, { fields: [carts.userId], references: [users.id] }),
  items: many(cartItems),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, { fields: [cartItems.cartId], references: [carts.id] }),
  variant: one(productVariants, { fields: [cartItems.variantId], references: [productVariants.id] }),
}));

export const inventoryRelations = relations(inventory, ({ one }) => ({
  variant: one(productVariants, { fields: [inventory.variantId], references: [productVariants.id] }),
}));

export const productImagesRelations = relations(productImages, ({ one }) => ({
  product: one(products, { fields: [productImages.productId], references: [products.id] }),
}));

export const addressesRelations = relations(addresses, ({ one }) => ({
  user: one(users, { fields: [addresses.userId], references: [users.id] }),
}));

export const ordersRelations = relations(orders, ({ many, one }) => ({
  customer: one(users, { fields: [orders.customerUserId], references: [users.id] }),
  orderAddresses: many(orderAddresses),
  items: many(orderItems),
}));

export const orderAddressesRelations = relations(orderAddresses, ({ one }) => ({
  order: one(orders, { fields: [orderAddresses.orderId], references: [orders.id] }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  store: one(stores, { fields: [orderItems.storeId], references: [stores.id] }),
  variant: one(productVariants, { fields: [orderItems.variantId], references: [productVariants.id] }),
}));