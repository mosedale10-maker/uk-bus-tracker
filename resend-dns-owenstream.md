# Resend DNS for owenstream.co.uk

Add these in Cloudflare → owenstream.co.uk → DNS → Records.
Proxy status: DNS only (grey cloud) for all of them.

| Type | Name | Priority | Content |
|------|------|----------|---------|
| TXT | resend._domainkey | — | p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDCELSpq9pMETIz7ydqTdFUi9M0UOOi0rN2YlDAcxCdEYUP8XhwiDkGKQo559xoOeKa5HutkJOTYz6UJbUk98f92GjbDsy3ssPbMMNeOe7RJiLVa05uCQnxQuABEvZuMcsn9Dov3hVjyy+oJ58DN6oxXAkNoepPAKUQF0PXmwvT+wIDAQAB |
| MX | send | 10 | feedback-smtp.us-east-1.amazonses.com |
| TXT | send | — | v=spf1 include:amazonses.com ~all |
| CNAME | rsend | — | send.forge.rmta.net |

After saving, reply **dns done** and I will verify the domain and resend the Plus thank-you emails.
