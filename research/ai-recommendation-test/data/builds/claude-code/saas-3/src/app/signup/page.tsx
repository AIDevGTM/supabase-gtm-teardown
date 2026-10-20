import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AuthForm } from "@/components/AuthForm";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  if (await getCurrentUser()) redirect("/dashboard");
  return <AuthForm mode="signup" next={searchParams.next} />;
}
