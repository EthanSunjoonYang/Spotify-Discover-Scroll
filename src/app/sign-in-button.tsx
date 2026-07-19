"use client";

import { signIn } from "next-auth/react";

export default function SignInButton() {
  return (
    <button className="spotify-btn" onClick={() => signIn("spotify")}>
      Continue with Spotify
    </button>
  );
}
