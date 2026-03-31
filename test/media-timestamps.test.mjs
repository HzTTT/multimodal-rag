import test from "node:test";
import assert from "node:assert/strict";
import { extractImageCapturedAt, extractTimestampFromFfprobeTags, resolveMediaCreatedAt } from "../dist/src/media-timestamps.js";

function makeJpegWithExifDate(dateTimeOriginal) {
  const exifString = Buffer.from(`${dateTimeOriginal}\0`, "ascii");

  const tiff = Buffer.alloc(64);
  tiff.write("MM", 0, "ascii");
  tiff.writeUInt16BE(0x2a, 2);
  tiff.writeUInt32BE(8, 4);

  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8769, 10);
  tiff.writeUInt16BE(4, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(26, 18);
  tiff.writeUInt32BE(0, 22);

  tiff.writeUInt16BE(1, 26);
  tiff.writeUInt16BE(0x9003, 28);
  tiff.writeUInt16BE(2, 30);
  tiff.writeUInt32BE(exifString.length, 32);
  tiff.writeUInt32BE(44, 36);
  tiff.writeUInt32BE(0, 40);
  exifString.copy(tiff, 44);

  const exifHeader = Buffer.from("Exif\0\0", "ascii");
  const app1Data = Buffer.concat([exifHeader, tiff]);
  const segmentLength = Buffer.alloc(2);
  segmentLength.writeUInt16BE(app1Data.length + 2, 0);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    segmentLength,
    app1Data,
    Buffer.from([0xff, 0xd9]),
  ]);
}

test("extractImageCapturedAt reads JPEG EXIF DateTimeOriginal", () => {
  const jpeg = makeJpegWithExifDate("2020:12:10 13:58:52");
  const timestamp = extractImageCapturedAt(jpeg, ".jpg");

  assert.equal(timestamp, new Date(2020, 11, 10, 13, 58, 52).getTime());
});

test("extractTimestampFromFfprobeTags prefers creation_time-style tags", () => {
  const timestamp = extractTimestampFromFfprobeTags({
    creation_time: "2026-03-26T13:23:31Z",
  });

  assert.equal(timestamp, Date.parse("2026-03-26T13:23:31Z"));
});

test("resolveMediaCreatedAt falls back to birthtime then mtime", async () => {
  const birthtimeMs = 1700000000000;
  const mtimeMs = 1800000000000;

  const timestamp = await resolveMediaCreatedAt(
    "/tmp/sample.png",
    "image",
    { birthtimeMs, mtimeMs },
    {
      readFile: async () => Buffer.from("not-an-image"),
      probeTags: async () => ({}),
    },
  );

  assert.equal(timestamp, birthtimeMs);
});
