# soonloh(순로; 順路)

A code generator companion for routers featuring build tool/framework-agnostic type-safe file-based routes.

## Quick Start

1. Install an appropriate build tool integration.
   <details>
   <summary>Vite</summary>

   ```ts
   import soonlohVite from 'soonloh/vite';

   export default defineConfig({
       plugins: [
           ...,
           soonlohVite(),
       ],
       ...,
   })
   ```

   </details>

1. Add `soonloh.config.ts`.

   ```ts
   import soonloh from 'soonloh';
   import { snzrwm } from 'soonloh/builtin-parsers';
   import { link } from 'soonloh/builtin-generators';

   export default soonloh.config({
     routerRoot: 'src/app/',
     parser: snzrwm.parser,
     generators: [link],
   });
   ```

1. :tada: It generates a code based on the file routes.

## Built-in Parsers

### snzrwm

The Soonzorowoom(순조로움) parser. You must end the filename with `page`, `route` or `ALLCAPS` so the parser can recognize.
The segments not only split by `/` but also by `.`.

**Examples**

- `api/post/like.$id.POST.tsx` meaning `POST /api/post/like/:id`
- `(website)/post.[$id]/page.tsx` meaning `GET /post` or `GET /post/:id`
- `(seo)/{sitemap.xml}/route.tsx` meaning `GET /sitemap.xml`
- `wiki/$+entry.page.tsx` meaning `GET /wiki/A`, `GET /wiki/A/B`, ... and so on

**Reference**

| Syntax         | Feature                                         |
| -------------- | ----------------------------------------------- |
| \_ignore       | Ignore the path recursively                     |
| $param         | Single value param                              |
| $+params       | Multi value params separated by `/`             |
| \[brackets\]   | By combining with params, make it optional      |
| (parenthesis)  | Make a grouping folder without affecting routes |
| {curly braces} | Escape the syntaxes above                       |

## Comparison

> [!NOTE]
> soonloh is not an alternative to the existing router libraries. It is an _companion codegen_ making them Build Their Own Type-safe File Routes.

### unrouting

- Both make url paths from file paths
- **soonloh**: provide build tools integration so people can build their own codegen
- **unrouting**: provide integration for radix3, vue router, etc

### generouted

TBD

### TanStack Router

TBD

### React Router > FS Routes

TBD

### Next.js (App Router)

TBD

### Next.js (Pages Router)

TBD
