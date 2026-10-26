import { randomUUID } from "node:crypto";
import { apiError, requireUser, supabaseRest } from "../../../lib/server/auth";

const bucket = "coval-profile-banners";
const maxFileSize = 5 * 1024 * 1024;

function storageConfig() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw Object.assign(new Error("Profile banner storage is not configured."), { status: 503 });
  return { url, key };
}

function supportedImage(file, bytes) {
  if (file.type === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (file.type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (file.type === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "";
}

async function removeObject(user, objectPath) {
  if (!objectPath) return;
  const { url, key } = storageConfig();
  const response = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${user.token}` },
    cache: "no-store",
  });
  if (!response.ok && response.status !== 404) throw Object.assign(new Error("The old profile banner could not be removed."), { status: response.status });
}

export async function POST(request) {
  let uploadedPath = "";
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ error: "Sign in to upload a profile banner." }, { status: 401 });
    const formData = await request.formData();
    const file = formData.get("banner");
    if (!file || typeof file.arrayBuffer !== "function") throw Object.assign(new Error("Choose a banner image to upload."), { status: 400 });
    if (file.size <= 0 || file.size > maxFileSize) throw Object.assign(new Error("Choose an image smaller than 5 MB."), { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const extension = supportedImage(file, bytes);
    if (!extension) throw Object.assign(new Error("Upload a PNG, JPEG, or WebP image."), { status: 400 });

    const { url, key } = storageConfig();
    uploadedPath = `${user.id}/${randomUUID()}.${extension}`;
    const upload = await fetch(`${url}/storage/v1/object/${bucket}/${uploadedPath.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${user.token}`, "Content-Type": file.type, "Cache-Control": "max-age=31536000" },
      body: bytes,
      cache: "no-store",
    });
    if (!upload.ok) {
      const payload = await upload.json().catch(() => null);
      throw Object.assign(new Error(payload?.message || "The banner could not be uploaded. Check that the profile banner storage migration has been applied."), { status: upload.status });
    }

    const [previous] = await supabaseRest(user, `coval_profiles?select=profile_banner_path&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    const updated = await supabaseRest(user, `coval_profiles?user_id=eq.${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ profile_banner_path: uploadedPath, updated_at: new Date().toISOString() }),
    });
    if (!updated?.length) throw Object.assign(new Error("Your COVAL profile was not found."), { status: 404 });
    await removeObject(user, previous?.profile_banner_path).catch(() => {});
    return Response.json({ bannerUrl: `${url}/storage/v1/object/public/${bucket}/${uploadedPath.split("/").map(encodeURIComponent).join("/")}` }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (uploadedPath) await removeObjectFromError(request, uploadedPath).catch(() => {});
    return apiError(error);
  }
}

async function removeObjectFromError(request, objectPath) {
  const user = await requireUser(request);
  return removeObject(user, objectPath);
}

export async function DELETE(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ error: "Sign in to remove your profile banner." }, { status: 401 });
    const [member] = await supabaseRest(user, `coval_profiles?select=profile_banner_path&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (member?.profile_banner_path) await removeObject(user, member.profile_banner_path);
    await supabaseRest(user, `coval_profiles?user_id=eq.${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ profile_banner_path: null, updated_at: new Date().toISOString() }),
    });
    return Response.json({ bannerUrl: "" }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
