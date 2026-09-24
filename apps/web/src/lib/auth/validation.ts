import { AUTH_LIMITS, EMAIL_PATTERN, SLUG_PATTERN } from "@zelora/shared";

/**
 * Client-side auth validation mirroring the API's shared rules.
 *
 * The authoritative rules live in `@zelora/shared` (`AUTH_LIMITS`,
 * `EMAIL_PATTERN`); this module reuses those constants verbatim so the form
 * hints match the server exactly instead of inventing parallel limits. Errors
 * are collected as per-field string arrays, the same shape the API emits in
 * `ApiErrorBody.fields`, so form state and server feedback are interchangeable.
 */

export type FieldErrors = Record<string, string[]>;

export function validateEmailAddress(email: string): string[] {
  const value = email.trim().toLowerCase();
  if (value.length === 0) {
    return ["Email is required."];
  }
  if (
    value.length < AUTH_LIMITS.emailMinLength ||
    value.length > AUTH_LIMITS.emailMaxLength
  ) {
    return [
      `Email must be between ${AUTH_LIMITS.emailMinLength} and ${AUTH_LIMITS.emailMaxLength} characters.`,
    ];
  }
  if (!EMAIL_PATTERN.test(value)) {
    return ["Enter a valid email address."];
  }
  return [];
}

export function validatePasswordValue(password: string): string[] {
  if (password.length === 0) {
    return ["Password is required."];
  }
  if (password.length < AUTH_LIMITS.passwordMinLength) {
    return [`Password must be at least ${AUTH_LIMITS.passwordMinLength} characters.`];
  }
  if (password.length > AUTH_LIMITS.passwordMaxLength) {
    return [`Password must be at most ${AUTH_LIMITS.passwordMaxLength} characters.`];
  }
  return [];
}

export function validateNameValue(name: string): string[] {
  const value = name.trim();
  if (value.length === 0) {
    return ["Name is required."];
  }
  if (
    value.length < AUTH_LIMITS.nameMinLength ||
    value.length > AUTH_LIMITS.nameMaxLength
  ) {
    return [
      `Name must be between ${AUTH_LIMITS.nameMinLength} and ${AUTH_LIMITS.nameMaxLength} characters.`,
    ];
  }
  return [];
}

export function validateLogin(email: string, password: string): FieldErrors {
  const fields: FieldErrors = {};
  const emailErrors = validateEmailAddress(email);
  if (emailErrors.length > 0) {
    fields.email = emailErrors;
  }
  const passwordErrors = validatePasswordValue(password);
  if (passwordErrors.length > 0) {
    fields.password = passwordErrors;
  }
  return fields;
}

export function validateRegister(
  name: string,
  email: string,
  password: string,
  confirmPassword: string,
): FieldErrors {
  const fields: FieldErrors = {};
  const nameErrors = validateNameValue(name);
  if (nameErrors.length > 0) {
    fields.name = nameErrors;
  }
  const emailErrors = validateEmailAddress(email);
  if (emailErrors.length > 0) {
    fields.email = emailErrors;
  }
  const passwordErrors = validatePasswordValue(password);
  if (passwordErrors.length > 0) {
    fields.password = passwordErrors;
  }
  if (confirmPassword !== password) {
    fields.confirmPassword = ["Passwords do not match."];
  }
  return fields;
}

/**
 * Validate a slug against {@link AUTH_LIMITS} and {@link SLUG_PATTERN}, the
 * same rule the API applies (trimmed and lowercased like the server's
 * `normalizeSlug`). Used for both the seller profile slug and the store slug.
 */
export function validateSlugValue(slug: string): string[] {
  const value = slug.trim().toLowerCase();
  if (value.length === 0) {
    return ["Slug is required."];
  }
  if (
    value.length < AUTH_LIMITS.slugMinLength ||
    value.length > AUTH_LIMITS.slugMaxLength
  ) {
    return [
      `Slug must be between ${AUTH_LIMITS.slugMinLength} and ${AUTH_LIMITS.slugMaxLength} characters.`,
    ];
  }
  if (!SLUG_PATTERN.test(value)) {
    return ["Slug must use lowercase letters, numbers and single hyphens."];
  }
  return [];
}

/** Validate a seller's public display name against {@link AUTH_LIMITS}. */
export function validateDisplayNameValue(displayName: string): string[] {
  const value = displayName.trim();
  if (value.length === 0) {
    return ["Display name is required."];
  }
  if (
    value.length < AUTH_LIMITS.displayNameMinLength ||
    value.length > AUTH_LIMITS.displayNameMaxLength
  ) {
    return [
      `Display name must be between ${AUTH_LIMITS.displayNameMinLength} and ${AUTH_LIMITS.displayNameMaxLength} characters.`,
    ];
  }
  return [];
}

/** Validate a store name against {@link AUTH_LIMITS}. */
export function validateStoreNameValue(storeName: string): string[] {
  const value = storeName.trim();
  if (value.length === 0) {
    return ["Store name is required."];
  }
  if (
    value.length < AUTH_LIMITS.storeNameMinLength ||
    value.length > AUTH_LIMITS.storeNameMaxLength
  ) {
    return [
      `Store name must be between ${AUTH_LIMITS.storeNameMinLength} and ${AUTH_LIMITS.storeNameMaxLength} characters.`,
    ];
  }
  return [];
}

/**
 * Validate the four seller-onboarding fields the API expects. Slugs are
 * normalized (trim + lowercase) exactly like the server, so the checked value
 * matches what is submitted.
 */
export function validateSellerOnboarding(
  slug: string,
  displayName: string,
  storeName: string,
  storeSlug: string,
): FieldErrors {
  const fields: FieldErrors = {};
  const slugErrors = validateSlugValue(slug);
  if (slugErrors.length > 0) {
    fields.slug = slugErrors;
  }
  const displayNameErrors = validateDisplayNameValue(displayName);
  if (displayNameErrors.length > 0) {
    fields.displayName = displayNameErrors;
  }
  const storeNameErrors = validateStoreNameValue(storeName);
  if (storeNameErrors.length > 0) {
    fields.storeName = storeNameErrors;
  }
  const storeSlugErrors = validateSlugValue(storeSlug);
  if (storeSlugErrors.length > 0) {
    fields.storeSlug = storeSlugErrors;
  }
  return fields;
}