import { describe, expect, it } from "vitest";
import { PRODUCT_IMAGE_LIMITS } from "@zelora/shared";
import {
  IMAGE_ACCEPT_ATTRIBUTE,
  remainingImageCapacity,
  validateImageSelection,
} from "./validation";

/**
 * A file of a chosen size, without allocating the bytes twice per test.
 *
 * `new Uint8Array(size)` is zero-filled, so the file is genuinely that many
 * bytes long, which is the only property the size check reads.
 */
function fileOfSize(name: string, size: number, type = "image/png"): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** `count` valid files, so capacity tests vary only the count. */
function files(count: number): File[] {
  return Array.from({ length: count }, (_unused, index) =>
    fileOfSize(`image-${index}.png`, 1024),
  );
}

describe("IMAGE_ACCEPT_ATTRIBUTE", () => {
  it("offers exactly the four formats the API accepts", () => {
    expect(IMAGE_ACCEPT_ATTRIBUTE).toBe("image/jpeg,image/png,image/webp,image/avif");
  });
});

describe("remainingImageCapacity", () => {
  it("reports the room left up to the cap", () => {
    expect(remainingImageCapacity(0)).toBe(PRODUCT_IMAGE_LIMITS.maxPerProduct);
    expect(remainingImageCapacity(7)).toBe(1);
  });

  it("clamps at zero rather than reporting a negative capacity", () => {
    expect(remainingImageCapacity(PRODUCT_IMAGE_LIMITS.maxPerProduct)).toBe(0);
    expect(remainingImageCapacity(PRODUCT_IMAGE_LIMITS.maxPerProduct + 3)).toBe(0);
  });
});

describe("validateImageSelection", () => {
  it("rejects an empty selection", () => {
    const result = validateImageSelection([], 0);

    expect(result.ok).toBe(false);
  });

  describe("per-product capacity", () => {
    it("accepts a selection that exactly fills the remaining capacity", () => {
      const result = validateImageSelection(files(3), 5);

      expect(result.ok).toBe(true);
    });

    it("rejects the 9th image once a product holds 8", () => {
      const result = validateImageSelection(files(1), PRODUCT_IMAGE_LIMITS.maxPerProduct);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the capacity check to refuse this selection");
      expect(result.message).toContain("maximum");
    });

    it("rejects a selection that would overflow the product, not just one past it", () => {
      const result = validateImageSelection(files(3), 6);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the capacity check to refuse this selection");
      expect(result.message).toContain("can add 2 more");
    });

    it("names the eight-image cap rather than a number of its own", () => {
      const result = validateImageSelection(files(1), 8);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the capacity check to refuse this selection");
      expect(result.message).toContain(String(PRODUCT_IMAGE_LIMITS.maxPerProduct));
    });
  });

  describe("files per request", () => {
    it("accepts a full batch of eight", () => {
      const result = validateImageSelection(files(8), 0);

      expect(result.ok).toBe(true);
    });

    it("rejects a ninth file in one request", () => {
      const result = validateImageSelection(files(9), 0);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the per-request check to refuse this selection");
      expect(result.message).toContain("at most 8");
    });
  });

  describe("per-file byte cap", () => {
    it("accepts a file of exactly the limit, because the cap is inclusive", () => {
      const result = validateImageSelection(
        [fileOfSize("at-limit.png", PRODUCT_IMAGE_LIMITS.maxBytesPerFile)],
        0,
      );

      expect(result.ok).toBe(true);
    });

    it("rejects a file one byte over the limit", () => {
      const result = validateImageSelection(
        [fileOfSize("over-limit.png", PRODUCT_IMAGE_LIMITS.maxBytesPerFile + 1)],
        0,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the size check to refuse this selection");
      expect(result.message).toContain("over-limit.png");
    });

    it("names the offending file so a seller can find it in their folder", () => {
      const result = validateImageSelection(
        [
          fileOfSize("fine.png", 1024),
          fileOfSize("huge.png", PRODUCT_IMAGE_LIMITS.maxBytesPerFile + 1),
        ],
        0,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the size check to refuse this selection");
      expect(result.message).toContain("huge.png");
      expect(result.message).not.toContain("fine.png");
    });

    it("rejects an empty file", () => {
      const result = validateImageSelection([fileOfSize("empty.png", 0)], 0);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the empty check to refuse this selection");
      expect(result.message).toContain("empty");
    });
  });

  describe("browser-declared type", () => {
    it("rejects a type the API does not accept", () => {
      const result = validateImageSelection(
        [fileOfSize("scan.tiff", 1024, "image/tiff")],
        0,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the type check to refuse this selection");
      expect(result.message).toContain("scan.tiff");
    });

    it("rejects a GIF, which is not one of the four supported formats", () => {
      const result = validateImageSelection([fileOfSize("loop.gif", 1024, "image/gif")], 0);

      expect(result.ok).toBe(false);
    });

    it("accepts each of the four supported types", () => {
      for (const type of ["image/jpeg", "image/png", "image/webp", "image/avif"]) {
        const result = validateImageSelection([fileOfSize(`ok.${type}`, 1024, type)], 0);

        expect(result.ok).toBe(true);
      }
    });

    it("accepts a type carrying parameters or odd casing", () => {
      const result = validateImageSelection(
        [fileOfSize("odd.png", 1024, "IMAGE/PNG")],
        0,
      );

      expect(result.ok).toBe(true);
    });

    it("lets an undeclared type through to the server, which sniffs the bytes", () => {
      // A browser or drag source that reports no type at all must not be
      // blocked: the API decides from the bytes, not from this field.
      const result = validateImageSelection([fileOfSize("mystery", 1024, "")], 0);

      expect(result.ok).toBe(true);
    });
  });

  describe("check order", () => {
    it("reports the capacity problem rather than a per-file one", () => {
      // Nine oversized files against a full product: the seller can fix this by
      // choosing fewer files, so that is what they are told.
      const result = validateImageSelection(
        files(9).map((file) => fileOfSize(file.name, PRODUCT_IMAGE_LIMITS.maxBytesPerFile + 1)),
        PRODUCT_IMAGE_LIMITS.maxPerProduct,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the request-cap check to fire first");
      expect(result.message).toContain("at most 8");
    });
  });
});
