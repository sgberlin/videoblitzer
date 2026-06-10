export const appConfig = {
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? "VideoBlitzer",
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? "https://api.videoblitzer.com",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  ownerEmail: process.env.NEXT_PUBLIC_OWNER_EMAIL ?? "gizlenweb@gmail.com",
};
