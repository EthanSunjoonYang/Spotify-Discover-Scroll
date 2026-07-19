import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import SignInButton from "./sign-in-button";

export default async function Home() {
  const session = await getServerSession(authOptions);

  if (session?.user) {
    redirect("/feed");
  }

  return (
    <main className="landing">
      <div className="landing-content">
        <h1>Discover Scroll</h1>
        <p>
          Scroll through songs pulled from artists you love and artists you
          have not discovered yet. Swipe or tap through, and save the ones
          you like straight to your real Spotify Liked Songs.
        </p>
        <SignInButton />
        <p className="hint">
          Spotify&apos;s own login screen will show up each time, so you can
          switch accounts there if you need to.
        </p>
      </div>
    </main>
  );
}
