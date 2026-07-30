# Module Layer Dependencies

This diagram is generated from dependency-cruiser. Update it with `pnpm architecture:graph`; verify it with `pnpm architecture:graph:check`.

```mermaid
flowchart LR

subgraph module_account["account"]
  node_account_public["public"]
  node_account_application["application"]
  node_account_domain["domain"]
  node_account_presentation["presentation"]
  node_account_transport["transport"]
end

subgraph module_auth["auth"]
  node_auth_public["public"]
  node_auth_application["application"]
  node_auth_domain["domain"]
  node_auth_infrastructure["infrastructure"]
  node_auth_presentation["presentation"]
  node_auth_transport["transport"]
end

subgraph module_book["book"]
  node_book_public["public"]
  node_book_application["application"]
  node_book_domain["domain"]
  node_book_infrastructure["infrastructure"]
  node_book_presentation["presentation"]
  node_book_transport["transport"]
end

subgraph module_email["email"]
  node_email_public["public"]
  node_email_application["application"]
  node_email_domain["domain"]
  node_email_infrastructure["infrastructure"]
  node_email_presentation["presentation"]
  node_email_transport["transport"]
end

subgraph module_genre["genre"]
  node_genre_public["public"]
  node_genre_application["application"]
  node_genre_domain["domain"]
  node_genre_infrastructure["infrastructure"]
  node_genre_presentation["presentation"]
  node_genre_transport["transport"]
end

subgraph module_kernel["kernel"]
  node_kernel_public["public"]
  node_kernel_application["application"]
  node_kernel_domain["domain"]
  node_kernel_infrastructure["infrastructure"]
  node_kernel_transport["transport"]
end

subgraph module_lifecycle_events["lifecycle-events"]
  node_lifecycle_events_public["public"]
  node_lifecycle_events_application["application"]
  node_lifecycle_events_domain["domain"]
  node_lifecycle_events_transport["transport"]
end

subgraph module_user["user"]
  node_user_public["public"]
  node_user_application["application"]
  node_user_domain["domain"]
  node_user_presentation["presentation"]
  node_user_transport["transport"]
end

node_account_application --> node_account_domain
node_account_domain --> node_kernel_public
node_account_presentation --> node_account_domain
node_account_presentation --> node_account_public
node_account_presentation --> node_auth_public
node_account_public --> node_account_application
node_account_public --> node_account_domain
node_account_public --> node_account_presentation
node_account_public --> node_account_transport
node_account_transport --> node_account_domain
node_account_transport --> node_auth_public
node_account_transport --> node_kernel_transport
node_auth_domain --> node_kernel_domain
node_auth_infrastructure --> node_auth_domain
node_auth_infrastructure --> node_auth_public
node_auth_infrastructure --> node_kernel_domain
node_auth_infrastructure --> node_kernel_infrastructure
node_auth_infrastructure --> node_kernel_public
node_auth_infrastructure --> node_kernel_transport
node_auth_infrastructure --> node_user_public
node_auth_presentation --> node_account_public
node_auth_presentation --> node_auth_domain
node_auth_presentation --> node_auth_public
node_auth_presentation --> node_kernel_domain
node_auth_presentation --> node_kernel_public
node_auth_public --> node_auth_application
node_auth_public --> node_auth_domain
node_auth_public --> node_auth_infrastructure
node_auth_public --> node_auth_presentation
node_auth_public --> node_auth_transport
node_auth_transport --> node_auth_domain
node_auth_transport --> node_auth_public
node_auth_transport --> node_kernel_public
node_auth_transport --> node_kernel_transport
node_book_application --> node_book_domain
node_book_application --> node_kernel_domain
node_book_domain --> node_kernel_domain
node_book_domain --> node_kernel_public
node_book_infrastructure --> node_book_domain
node_book_infrastructure --> node_genre_infrastructure
node_book_infrastructure --> node_genre_public
node_book_infrastructure --> node_kernel_infrastructure
node_book_infrastructure --> node_kernel_public
node_book_presentation --> node_auth_public
node_book_presentation --> node_book_domain
node_book_presentation --> node_book_public
node_book_presentation --> node_genre_public
node_book_presentation --> node_kernel_domain
node_book_presentation --> node_kernel_public
node_book_public --> node_book_application
node_book_public --> node_book_domain
node_book_public --> node_book_infrastructure
node_book_public --> node_book_presentation
node_book_public --> node_book_transport
node_book_transport --> node_auth_public
node_book_transport --> node_book_domain
node_book_transport --> node_kernel_domain
node_book_transport --> node_kernel_public
node_book_transport --> node_kernel_transport
node_email_application --> node_email_domain
node_email_application --> node_kernel_domain
node_email_infrastructure --> node_email_public
node_email_infrastructure --> node_kernel_domain
node_email_infrastructure --> node_kernel_infrastructure
node_email_infrastructure --> node_kernel_public
node_email_presentation --> node_auth_public
node_email_public --> node_email_application
node_email_public --> node_email_domain
node_email_public --> node_email_infrastructure
node_email_public --> node_email_presentation
node_email_public --> node_email_transport
node_email_public --> node_kernel_public
node_email_transport --> node_email_public
node_email_transport --> node_kernel_domain
node_genre_application --> node_genre_domain
node_genre_domain --> node_kernel_public
node_genre_infrastructure --> node_genre_domain
node_genre_infrastructure --> node_kernel_domain
node_genre_infrastructure --> node_kernel_infrastructure
node_genre_presentation --> node_genre_domain
node_genre_presentation --> node_genre_public
node_genre_presentation --> node_kernel_domain
node_genre_public --> node_genre_application
node_genre_public --> node_genre_domain
node_genre_public --> node_genre_infrastructure
node_genre_public --> node_genre_presentation
node_genre_public --> node_genre_transport
node_genre_transport --> node_auth_public
node_genre_transport --> node_kernel_domain
node_genre_transport --> node_kernel_transport
node_kernel_infrastructure --> node_auth_infrastructure
node_kernel_infrastructure --> node_book_infrastructure
node_kernel_infrastructure --> node_email_infrastructure
node_kernel_infrastructure --> node_genre_infrastructure
node_kernel_infrastructure --> node_kernel_domain
node_kernel_infrastructure --> node_kernel_transport
node_kernel_public --> node_kernel_application
node_kernel_public --> node_kernel_domain
node_kernel_public --> node_kernel_infrastructure
node_kernel_public --> node_kernel_transport
node_kernel_transport --> node_kernel_domain
node_lifecycle_events_application --> node_kernel_domain
node_lifecycle_events_public --> node_kernel_infrastructure
node_lifecycle_events_public --> node_kernel_public
node_lifecycle_events_public --> node_lifecycle_events_application
node_lifecycle_events_public --> node_lifecycle_events_domain
node_lifecycle_events_public --> node_lifecycle_events_transport
node_user_application --> node_user_domain
node_user_domain --> node_kernel_domain
node_user_presentation --> node_auth_public
node_user_presentation --> node_kernel_domain
node_user_presentation --> node_kernel_public
node_user_presentation --> node_user_domain
node_user_presentation --> node_user_public
node_user_public --> node_user_application
node_user_public --> node_user_domain
node_user_public --> node_user_presentation
node_user_public --> node_user_transport
node_user_transport --> node_auth_public
node_user_transport --> node_kernel_domain
node_user_transport --> node_kernel_transport
node_user_transport --> node_user_domain

linkStyle 6 stroke-dasharray: 1 4
linkStyle 7 stroke-dasharray: 1 4
linkStyle 8 stroke-dasharray: 1 4
linkStyle 10 stroke-dasharray: 6 4
linkStyle 26 stroke-dasharray: 1 4
linkStyle 50 stroke-dasharray: 1 4
linkStyle 52 stroke-dasharray: 1 4
linkStyle 53 stroke-dasharray: 1 4
linkStyle 54 stroke-dasharray: 6 4
linkStyle 67 stroke-dasharray: 1 4
linkStyle 69 stroke-dasharray: 1 4
linkStyle 83 stroke-dasharray: 1 4
linkStyle 85 stroke-dasharray: 1 4
linkStyle 86 stroke-dasharray: 1 4
linkStyle 87 stroke-dasharray: 6 4
linkStyle 92 stroke-dasharray: 1 4
linkStyle 96 stroke-dasharray: 1 4
linkStyle 97 stroke-dasharray: 1 4
linkStyle 99 stroke-dasharray: 6 4
linkStyle 105 stroke-dasharray: 1 4
linkStyle 115 stroke-dasharray: 1 4
linkStyle 116 stroke-dasharray: 1 4
linkStyle 117 stroke-dasharray: 1 4
linkStyle 118 stroke-dasharray: 6 4
```

## Edge Styles

- Solid edges are static runtime imports.
- Dashed edges are dynamic imports or type-only dependencies.
- Dotted edges are re-export-only dependencies.
