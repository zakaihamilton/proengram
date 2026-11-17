import { redirect } from "next/navigation";
import { getDashboardIdentity } from "@/lib/auth/session";

export default async function HomePage() {
  const identity = await getDashboardIdentity();
  redirect(identity ? "/overview" : "/login");
}
