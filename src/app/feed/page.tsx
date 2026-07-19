import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import FeedClient from "./FeedClient";

export default async function FeedPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/");
  }

  return <FeedClient />;
}
