
export default function LoginHome() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://zriirrxmkfggyhoagtov.supabase.co";
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_-LR8TY6q0UfmOevgRmDzWA_VJqck38C";
  const loginPage = `/coval-login.html?supabaseUrl=${encodeURIComponent(supabaseUrl)}&supabaseKey=${encodeURIComponent(supabaseKey)}`;
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100dvh",
        overflow: "hidden",
        background: "#080b10",
      }}
    >
      <iframe
        title="COVAL sign in"
        src={loginPage}
        style={{
          border: 0,
          width: "100%",
          height: "100%",
        }}
      />
    </main>
  );
}
