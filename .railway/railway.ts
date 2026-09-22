import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "sfo" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 500 });
  const ukBusTracker = service("uk-bus-tracker", {
    replicas: { "sfo": 1 },
    env: { AUTH_SECRET: preserve(), BODS_API_KEY: preserve(), DATABASE_URL: preserve(), MAIL_FROM: preserve(), PAYPAL_CLIENT_ID: preserve(), PAYPAL_CLIENT_SECRET: preserve(), PAYPAL_MODE: preserve(), PLUS_AMOUNT: preserve(), PLUS_CHECKOUT_URL: preserve(), PLUS_CURRENCY: preserve(), PLUS_PRICE_LABEL: preserve(), PLUS_UNLOCK_CODE: preserve(), PUBLIC_SITE_URL: preserve(), RESEND_API_KEY: preserve(), VITE_DONATE_URL: preserve(), VITE_PLUS_PRICE: preserve() },
  });

  return project("uk-bus-tracker", {
    resources: [ukBusTracker, Postgres, postgresVolume],
  });
});
