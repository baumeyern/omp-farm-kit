# Repo-side snippets

## .gitignore

```gitignore
# impeccable design-skill scratch output
.impeccable/
```

## GitHub Actions: never cancel an in-flight deploy

Lockless shipping (the `ship` skill) relies on this: a running deploy always finishes, and a newer
push replaces only the pending run, which already contains every earlier commit.

```yaml
concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false
```

## farm.config.json for a SvelteKit repo with a staging mirror

What the source farm used (paths are examples):

```json
{
	"owner": "<your first name>",
	"repo": "C:/Users/<you>/code/<project>",
	"baseRef": "origin/main",
	"upstreamRef": "origin/staging",
	"mergedRefs": ["origin/main", "origin/staging"],
	"linkNodeModules": true,
	"setupCommands": [["node", "node_modules/@sveltejs/kit/svelte-kit.js", "sync"]]
}
```
