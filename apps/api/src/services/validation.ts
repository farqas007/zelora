import { ValidationError } from "@zelora/core";
import { isValidId } from "@zelora/db/ids";
import {
  AUTH_LIMITS,
  CART_ITEM_QUANTITY_LIMITS,
  EMAIL_PATTERN,
  PRODUCT_LIMITS,
  PRODUCT_SLUG_PATTERN,
  SLUG_PATTERN,
  type AddCartItemRequest,
  type CreateProductRequest,
  type LoginRequest,
  type RegisterRequest,
  type SellerOnboardingRequest,
  type UpdateCartItemRequest,
} from "@zelora/shared";

/**
 * API-level validation/normalization for Phase 3 auth requests. Input is
 * normalized first (email trimmed + lowercased, name trimmed), then validated
 * against the shared {@link AUTH_LIMITS}. Field problems are collected into a
 * single {@link ValidationError} carrying per-field message arrays.
 *
 * This module is intentionally API-specific: it must not be moved into
 * shared/core because browser-facing contracts stay dependency-free.
 */

type FieldErrors = Record<string, string[]>;

/** Trim surrounding whitespace and lowercase an email address. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Trim surrounding whitespace from a display name. */
export function normalizeName(name: string): string {
  return name.trim();
}

/** Trim surrounding whitespace and lowercase a slug. */
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/** Validate a (previously normalized) email. Returns an empty array when valid. */
export function validateEmail(email: string): string[] {
  if (
    email.length < AUTH_LIMITS.emailMinLength ||
    email.length > AUTH_LIMITS.emailMaxLength
  ) {
    return [
      `Email must be between ${AUTH_LIMITS.emailMinLength} and ${AUTH_LIMITS.emailMaxLength} characters.`,
    ];
  }
  if (!EMAIL_PATTERN.test(email)) {
    return ["Email is invalid."];
  }
  return [];
}

/** Validate a password length against {@link AUTH_LIMITS}. Passwords are never normalized. */
export function validatePassword(password: string): string[] {
  if (password.length < AUTH_LIMITS.passwordMinLength) {
    return [`Password must be at least ${AUTH_LIMITS.passwordMinLength} characters.`];
  }
  if (password.length > AUTH_LIMITS.passwordMaxLength) {
    return [`Password must be at most ${AUTH_LIMITS.passwordMaxLength} characters.`];
  }
  return [];
}

/** Validate a (previously trimmed) name against {@link AUTH_LIMITS}. */
export function validateName(name: string): string[] {
  if (
    name.length < AUTH_LIMITS.nameMinLength ||
    name.length > AUTH_LIMITS.nameMaxLength
  ) {
    return [
      `Name must be between ${AUTH_LIMITS.nameMinLength} and ${AUTH_LIMITS.nameMaxLength} characters.`,
    ];
  }
  return [];
}

/** Validate a (previously normalized) slug against {@link AUTH_LIMITS} and {@link SLUG_PATTERN}. */
export function validateSlug(slug: string, label = "Slug"): string[] {
  if (
    slug.length < AUTH_LIMITS.slugMinLength ||
    slug.length > AUTH_LIMITS.slugMaxLength
  ) {
    return [
      `${label} must be between ${AUTH_LIMITS.slugMinLength} and ${AUTH_LIMITS.slugMaxLength} characters.`,
    ];
  }
  if (!SLUG_PATTERN.test(slug)) {
    return [`${label} is invalid.`];
  }
  return [];
}

/** Validate a (previously trimmed) display name against {@link AUTH_LIMITS}. */
export function validateDisplayName(displayName: string): string[] {
  if (
    displayName.length < AUTH_LIMITS.displayNameMinLength ||
    displayName.length > AUTH_LIMITS.displayNameMaxLength
  ) {
    return [
      `Display name must be between ${AUTH_LIMITS.displayNameMinLength} and ${AUTH_LIMITS.displayNameMaxLength} characters.`,
    ];
  }
  return [];
}

/** Validate a (previously trimmed) store name against {@link AUTH_LIMITS}. */
export function validateStoreName(storeName: string): string[] {
  if (
    storeName.length < AUTH_LIMITS.storeNameMinLength ||
    storeName.length > AUTH_LIMITS.storeNameMaxLength
  ) {
    return [
      `Store name must be between ${AUTH_LIMITS.storeNameMinLength} and ${AUTH_LIMITS.storeNameMaxLength} characters.`,
    ];
  }
  return [];
}

/** Validate a (previously trimmed) product name against {@link PRODUCT_LIMITS}. */
export function validateProductName(name: string): string[] {
  if (name.length < PRODUCT_LIMITS.nameMinLength || name.length > PRODUCT_LIMITS.nameMaxLength) {
    return [
      `Product name must be between ${PRODUCT_LIMITS.nameMinLength} and ${PRODUCT_LIMITS.nameMaxLength} characters.`,
    ];
  }
  return [];
}

/**
 * Validate a (previously normalized) product slug against
 * {@link PRODUCT_LIMITS} and {@link PRODUCT_SLUG_PATTERN}.
 */
export function validateProductSlug(slug: string): string[] {
  if (slug.length < PRODUCT_LIMITS.slugMinLength || slug.length > PRODUCT_LIMITS.slugMaxLength) {
    return [
      `Product slug must be between ${PRODUCT_LIMITS.slugMinLength} and ${PRODUCT_LIMITS.slugMaxLength} characters.`,
    ];
  }
  if (!PRODUCT_SLUG_PATTERN.test(slug)) {
    return ["Product slug is invalid."];
  }
  return [];
}

/** Reject anything that is not a plain JSON object body. */
function asObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("The request is invalid.", {
      body: ["Request body must be a JSON object."],
    });
  }
  return body as Record<string, unknown>;
}

function addFieldError(fields: FieldErrors, field: string, message: string): void {
  const existing = fields[field];
  if (existing === undefined) {
    fields[field] = [message];
  } else {
    existing.push(message);
  }
}

function collectField(
  fields: FieldErrors,
  record: Record<string, unknown>,
  field: string,
  label: string,
  normalize: (value: string) => string,
  validate: (value: string) => string[],
): string | null {
  const raw = record[field];
  if (raw === undefined || raw === null) {
    addFieldError(fields, field, `${label} is required.`);
    return null;
  }
  if (typeof raw !== "string") {
    addFieldError(fields, field, `${label} must be a string.`);
    return null;
  }
  const value = normalize(raw);
  for (const message of validate(value)) {
    addFieldError(fields, field, message);
  }
  return value;
}

/**
 * Parse and validate a register request body. Returns the normalized request;
 * throws a {@link ValidationError} with per-field errors on any problem.
 */
export function parseRegisterRequest(body: unknown): RegisterRequest {
  const record = asObjectBody(body);
  const fields: FieldErrors = {};

  const email = collectField(fields, record, "email", "Email", normalizeEmail, validateEmail);
  const password = collectField(fields, record, "password", "Password", (value) => value, validatePassword);
  const name = collectField(fields, record, "name", "Name", normalizeName, validateName);

  if (Object.keys(fields).length > 0) {
    throw new ValidationError("The request is invalid.", fields);
  }

  return { email: email as string, password: password as string, name: name as string };
}

/**
 * Parse and validate a login request body. Returns the normalized request;
 * throws a {@link ValidationError} with per-field errors on any problem.
 */
export function parseLoginRequest(body: unknown): LoginRequest {
  const record = asObjectBody(body);
  const fields: FieldErrors = {};

  const email = collectField(fields, record, "email", "Email", normalizeEmail, validateEmail);
  const password = collectField(fields, record, "password", "Password", (value) => value, validatePassword);

  if (Object.keys(fields).length > 0) {
    throw new ValidationError("The request is invalid.", fields);
  }

  return { email: email as string, password: password as string };
}

/**
 * Parse and validate a seller-onboarding request body. Slugs are normalized
 * (trim + lowercase), names are trimmed, and every field is checked against
 * the shared {@link AUTH_LIMITS} and {@link SLUG_PATTERN}. Field problems are
 * collected into a single {@link ValidationError} with per-field errors. Only
 * the four onboarding fields are consumed; anything else in the body is
 * ignored (never trusted) by callers.
 */
export function parseSellerOnboardingRequest(body: unknown): SellerOnboardingRequest {
  const record = asObjectBody(body);
  const fields: FieldErrors = {};

  const slug = collectField(fields, record, "slug", "Slug", normalizeSlug, (value) => validateSlug(value, "Slug"));
  const displayName = collectField(fields, record, "displayName", "Display name", normalizeName, validateDisplayName);
  const storeName = collectField(fields, record, "storeName", "Store name", normalizeName, validateStoreName);
  const storeSlug = collectField(fields, record, "storeSlug", "Store slug", normalizeSlug, (value) => validateSlug(value, "Store slug"));

  if (Object.keys(fields).length > 0) {
    throw new ValidationError("The request is invalid.", fields);
  }

  return {
    slug: slug as string,
    displayName: displayName as string,
    storeName: storeName as string,
    storeSlug: storeSlug as string,
  };
}

/**
 * Upper bound on a variant id. UUIDv7 ids are 36 characters; this cap only
 * protects the DB/API from absurd string payloads.
 */
const VARIANT_ID_MAX_LENGTH = 64;

/** Collect an integer field within `[min, max]`; problems are added to `fields`. */
function collectQuantity(
  fields: FieldErrors,
  record: Record<string, unknown>,
  field: string,
): number | null {
  const raw = record[field];
  if (raw === undefined || raw === null) {
    addFieldError(fields, field, "Quantity is required.");
    return null;
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    addFieldError(fields, field, "Quantity must be a whole number.");
    return null;
  }
  if (raw < CART_ITEM_QUANTITY_LIMITS.min || raw > CART_ITEM_QUANTITY_LIMITS.max) {
    addFieldError(fields, field, `Quantity must be between ${CART_ITEM_QUANTITY_LIMITS.min} and ${CART_ITEM_QUANTITY_LIMITS.max}.`);
    return null;
  }
  return raw;
}

/**
 * Parse and validate an add-cart-item request body. `variantId` is required
 * and length-capped; `quantity` must be an integer within
 * {@link CART_ITEM_QUANTITY_LIMITS}. Uses JSON-native numbers: a string
 * `"3"` is rejected (the web client always sends a real number). Field
 * problems are collected into a single {@link ValidationError}.
 */
export function parseAddCartItemRequest(body: unknown): AddCartItemRequest {
  const record = asObjectBody(body);
  const fields: FieldErrors = {};

  const variantId = collectField(fields, record, "variantId", "Variant id", (value) => value, (value) => {
    if (value.length === 0) {
      return ["Variant id is required."];
    }
    if (value.length > VARIANT_ID_MAX_LENGTH) {
      return [`Variant id must be at most ${VARIANT_ID_MAX_LENGTH} characters.`];
    }
    return [];
  });
  const quantity = collectQuantity(fields, record, "quantity");

  if (Object.keys(fields).length > 0) {
    throw new ValidationError("The request is invalid.", fields);
  }

  return { variantId: variantId as string, quantity: quantity as number };
}

/**
 * Parse and validate an update-cart-item request body. Only `quantity` is
 * accepted (an item's variant never changes; a mismatch means removing and
 * re-adding). Same integer-domain rules as {@link parseAddCartItemRequest}.
 */
export function parseUpdateCartItemRequest(body: unknown): UpdateCartItemRequest {
  const record = asObjectBody(body);
  const fields: FieldErrors = {};

  const quantity = collectQuantity(fields, record, "quantity");

  if (Object.keys(fields).length > 0) {
    throw new ValidationError("The request is invalid.", fields);
  }

  return { quantity: quantity as number };
}

/**
 * Collect an optional string field. Missing (`undefined`/`null`) is allowed;
 * anything present must be a string that passes `validate`. Problems are added
 * to `fields` and `undefined` is returned for that field.
 */
function collectOptionalString(
  fields: FieldErrors,
  record: Record<string, unknown>,
  field: string,
  validate: (value: string) => string[],
): string | undefined {
  const raw = record[field];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    addFieldError(fields, field, `${field} must be a string.`);
    return undefined;
  }
  for (const message of validate(raw)) {
    addFieldError(fields, field, message);
  }
  return raw;
}

/**
 * Parse and validate a seller product-creation request body. `name` and
 * `slug` are required; both are normalized (trim; slug also lowercased) and
 * checked against {@link PRODUCT_LIMITS} and {@link PRODUCT_SLUG_PATTERN}.
 * `description` is optional and length-capped; `categoryId` is optional and
 * must be a canonical UUIDv7 when present. Ownership fields (`storeId`,
 * `sellerProfileId`, `userId`, `status`) are ignored: the API resolves the
 * store from the authenticated session. Field problems are collected into a
 * single {@link ValidationError}.
 */
export function parseCreateProductRequest(body: unknown): CreateProductRequest {
  const record = asObjectBody(body);
  const fields: FieldErrors = {};

  const name = collectField(fields, record, "name", "Product name", normalizeName, validateProductName);
  const slug = collectField(fields, record, "slug", "Product slug", normalizeSlug, validateProductSlug);
  const description = collectOptionalString(fields, record, "description", (value) => {
    if (value.length > PRODUCT_LIMITS.descriptionMaxLength) {
      return [`Description must be at most ${PRODUCT_LIMITS.descriptionMaxLength} characters.`];
    }
    return [];
  });
  const categoryId = collectOptionalString(fields, record, "categoryId", (value) => {
    if (!isValidId(value)) {
      return ["categoryId must be a valid product category id."];
    }
    return [];
  });

  if (Object.keys(fields).length > 0) {
    throw new ValidationError("The request is invalid.", fields);
  }

  const result: CreateProductRequest = {
    name: name as string,
    slug: slug as string,
  };
  if (description !== undefined) {
    result.description = description;
  }
  if (categoryId !== undefined) {
    result.categoryId = categoryId;
  }
  return result;
}