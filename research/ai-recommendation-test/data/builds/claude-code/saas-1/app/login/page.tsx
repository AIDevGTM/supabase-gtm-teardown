import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Log in · Acme SaaS" };

export default function LoginPage({ searchParams }: { searchParams: { next?: string } }) {
  return <AuthForm mode="login" next={searchParams.next} />;
}
