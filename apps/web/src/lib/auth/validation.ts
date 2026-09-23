import { AUTH_LIMITS, EMAIL_PATTERN } from "@zelora/shared";

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