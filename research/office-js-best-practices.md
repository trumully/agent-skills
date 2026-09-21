# Office.js and Excel add-in best practices

**Scope.** This note distills durable guidance for an agent that writes Office Add-ins with Office.js, with extra attention to Excel. It separates documented requirements and behavior from Microsoft recommendations and from skill-level design recommendations. **All sources were accessed 2026-09-16.** Requirement-set tables and platform notes are versioned; re-check the cited compatibility pages for the target client before shipping.

## Executive summary

1. **Initialize deliberately.** Load the production Office.js CDN script in the HTML `<head>`, then wait for `Office.onReady()` before using Office APIs or rendering Office-dependent application code. Microsoft recommends `Office.onReady()` over the still-supported, single-handler `Office.initialize`; its result identifies the host and platform, and both may be `null` when the page is opened in an ordinary browser. [Documented requirement/behavior: [Initialize your Office Add-in](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/initialize-add-in); [Loading the DOM and runtime environment](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/loading-the-dom-and-runtime-environment); [Referencing the Office JavaScript API library](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/referencing-the-javascript-api-for-office-library-from-its-cdn)]
2. **Use capability checks, not guesses.** Distinguish host/platform detection from API availability. Gate optional features with `Office.context.requirements.isSetSupported("ExcelApi", "x.y")` (the version is a string), and use manifest requirements only for capabilities that are essential to any meaningful experience. [Documented behavior/recommendation: [Check for API availability at runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-api-requirements-runtime); [Specify Office applications and API requirements with the add-in only manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-office-hosts-and-api-requirements)]
3. **Treat Excel APIs as a remote, batched object model.** `Excel.run` supplies a `RequestContext`; `Range`, `Worksheet`, `Table`, and `Chart` variables are proxy objects. Queue compatible reads, writes, and method calls; load only data that JavaScript must read; await `context.sync()` at data-dependency boundaries. [Documented behavior: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model); [Excel.RequestContext](https://learn.microsoft.com/en-us/javascript/api/excel/excel.requestcontext?view=excel-js-preview)]
4. **Shape the work and the payload.** Avoid `sync()` in item loops, repeated proxy construction, parameterless loads, and cell-at-a-time writes. Prefer in-memory two-dimensional arrays and block `Range` assignments; use correlated objects for object-plus-metadata processing; split only when a payload or cell-count limit requires it. Excel on the web limits requests and responses to 5 MB, and range get operations are limited to 5,000,000 cells on all platforms. [Documented recommendation/limits: [Excel performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance); [Avoid using the context.sync method in loops](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/correlated-objects-pattern); [Resource limits and performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/resource-limits-and-performance-optimization)]
5. **Make object lifetime explicit only when needed.** Keep proxies within their request context. Track an object only when it must survive synchronization and the normal sequential execution of a `run` batch; untrack/remove it when finished. Explicit tracking is usually unnecessary, but can matter for very large numbers of temporary proxies. [Documented behavior: [OfficeExtension.TrackedObjects](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.trackedobjects?view=common-js-preview); [Resource limits and performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/resource-limits-and-performance-optimization)]
6. **Make events, errors, and runtimes lifecycle-aware.** Excel object events are registered and removed through the request context and do not persist in the workbook or across sessions. Catch the `Excel.run`/`context.sync()` promise, use the stable error code and diagnostic fields, and remember that a task pane, event handler, custom function, and dialog may run in different runtimes with different APIs. [Documented behavior: [Work with Events using the Excel JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-events); [OfficeExtension.Error](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.error?view=common-js-preview); [Runtimes in Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/runtimes)]

## Evidence labels and scope

- **Documented requirement/behavior** means the cited Microsoft documentation says that a call, manifest element, lifecycle rule, or platform limitation is required or describes the observed contract.
- **Documented recommendation** means the cited Microsoft documentation uses recommendation/best-practice language.
- **Skill recommendation** is an operational rule for an agent derived from the documented model. It is not a new Office.js contract; where it matters, the underlying source is cited.
- **Generic Office.js** applies to the Common API or to application-specific APIs shared by Excel, Word, PowerPoint, OneNote, or Visio. **Excel-specific** behavior is labeled as such. Outlook and Project do not use the application-specific model described here; use their Common APIs. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model); [Common JavaScript API object model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/office-javascript-api-object-model)]

## Principles

1. **Start only after both worlds are ready.** Office loads the DOM and the Office runtime asynchronously and in parallel; application code must wait for the appropriate readiness signal. [Documented behavior: [Loading the DOM and runtime environment](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/loading-the-dom-and-runtime-environment)]
2. **Separate capability from identity.** `Office.HostType.Excel` tells the add-in which host is running; it does not prove that an individual API member or requirement-set version is present. Check the requirement set or the documented setless member check before optional calls. [Documented behavior: [Check for API availability at runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-api-requirements-runtime); [Office.ContextInformation](https://learn.microsoft.com/en-us/javascript/api/office/office.contextinformation?view=common-js-preview)]
3. **Batch around dependencies, not around arbitrary lines.** A sync is needed when queued reads must be returned to JavaScript or when a phase must be committed; independent writes can normally be queued together. [Documented behavior/recommendation: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model)]
4. **Transfer data in the shape the host expects.** A bounded block range and a two-dimensional array generally express a bulk operation more directly than thousands of single-cell proxies. [Documented recommendation: [Excel performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance)]
5. **Make fallbacks honest.** A feature that is optional in the product should be optional in the manifest and visibly degraded at runtime; a feature required for any useful operation belongs in the base requirement declaration. [Documented recommendation: [Specify Office applications and API requirements with the add-in only manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-office-hosts-and-api-requirements)]

## Initialization, host, platform, and loading

### `Office.onReady()` versus `Office.initialize`

**Documented recommendation.** Use `Office.onReady()` for new code. It returns a Promise and accepts callbacks that can be registered from different parts of the application. `Office.initialize` remains supported, but only one handler can be assigned and it runs once; if code assigns the handler after the initialization event, it may never run. [Source: [Initialize your Office Add-in](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/initialize-add-in#initialize-with-officeonready); [Major differences between Office.initialize and Office.onReady](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/initialize-add-in#major-differences-between-officeinitialize-and-officeonready)]

**Documented requirement/behavior.** An add-in must not call Office APIs until Office.js has loaded. Even if there is no startup logic, Microsoft says to call `Office.onReady()` or assign an empty `Office.initialize` function because some Office/application combinations do not load the task pane until one of these occurs. [Source: [Initialize your Office Add-in](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/initialize-add-in#major-differences-between-officeinitialize-and-officeonready)]

A framework-neutral startup shape is:

```ts
Office.onReady((info) => {
  const inExcel = info?.host === Office.HostType.Excel;

  // Render the UI in a browser too; Office host values are null outside Office.
  renderApp({ inExcel, platform: info?.platform ?? null });
});
```

When maintaining legacy code, `Office.initialize = (reason) => { ... }` can distinguish the documented `inserted` and `documentOpened` reasons for task pane/content add-ins. Do not introduce that single-handler limitation into new code. [Source: [Initialize your Office Add-in](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/initialize-add-in#initialize-with-officeinitialize)]

### Host and platform detection

`Office.onReady()` supplies `host` (`Office.HostType`) and `platform` (`Office.PlatformType`). After initialization, the same environment is available through `Office.context.host`, `Office.context.platform`, and `Office.context.diagnostics`; `ContextInformation` also exposes the Office client `version`. Outside an Office host, `onReady` resolves with null host and platform values. [Source: [Initialize your Office Add-in](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/initialize-add-in#initialize-with-officeonready); [Office.Context](https://learn.microsoft.com/en-us/javascript/api/office/office.context?view=common-js-preview); [Office.ContextInformation](https://learn.microsoft.com/en-us/javascript/api/office/office.contextinformation?view=common-js-preview)]

**Skill recommendation.** Use the enums and requirement-set checks rather than parsing the user agent or inferring support from a host string. Use `diagnostics.version` only for a documented build-level condition that cannot be expressed by a requirement set; build formats and availability are platform-specific. [Underlying sources: [Office.ContextInformation](https://learn.microsoft.com/en-us/javascript/api/office/office.contextinformation?view=common-js-preview); [Office versions and requirement sets](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/office-versions-and-requirement-sets)]

### DOM, CDN, and framework order

**Documented requirement.** Put the Office.js CDN reference in the first HTML page's `<head>`, before application/framework scripts. The current production `/1/office.js` endpoint is the durable CDN reference; `/beta/office.js` is for preview APIs. Microsoft says not to bundle Office.js, and Marketplace add-ins must use the CDN reference. [Source: [Referencing the Office JavaScript API library](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/referencing-the-javascript-api-for-office-library-from-its-cdn); [Specify Office applications and API requirements with the add-in only manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-office-hosts-and-api-requirements#use-the-latest-office-javascript-api-library)]

```html
<head>
  <script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>
  <!-- Framework/application bundles come after Office.js. -->
</head>
```

**Documented behavior.** The DOM and Office runtime initialize in parallel. For React, Angular, Vue, Svelte, or another client-side framework, initialize/render the framework after `Office.onReady()`; rendering Office-dependent code first can cause Office API calls to fail. [Source: [Connect Office.js to any JavaScript framework](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/connect-to-javascript-frameworks); [Loading the DOM and runtime environment](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/loading-the-dom-and-runtime-environment)]

If the CDN is blocked by a network filter, firewall, or browser extension, `Office.onReady()` never resolves. Microsoft's framework guidance shows an application-level timeout that displays a diagnostic, but that timeout is a UI/network fallback, not cancellation of an Office host request. [Documented behavior and example: [Connect Office.js to any JavaScript framework](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/connect-to-javascript-frameworks#network-blocking-and-firewalls); [Initialize your Office Add-in](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/initialize-add-in)]

Use the human-readable `office.debug.js` only while debugging; Microsoft says to avoid it when publishing or deploying. [Source: [Debug Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/debug-add-ins-overview#versions-of-officejs-for-debugging)]

## API models and the Excel request model

### Pick the right model

Office.js has two broad models:

- **Application-specific model (generic across supported apps):** strongly typed objects and Promise-based batching for Excel, Word, PowerPoint, OneNote, and Visio. The concepts below use Excel examples.
- **Common API model:** shared runtime, UI, dialog, settings, bindings, and file APIs. Outlook uses Common APIs (especially `Mailbox`) and Project does not support the application-specific model.

Use the application-specific model for Excel workbook operations and Common APIs only for a feature that is genuinely common or not available in the Excel model. [Source: [Understand the Office JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/understand-the-javascript-api-for-office); [Common JavaScript API object model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/office-javascript-api-object-model); [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model)]

### `Excel.run`, `RequestContext`, and proxies

**Documented behavior.** Office and the add-in run in different processes. `Excel.run` creates and supplies an `Excel.RequestContext`, which connects JavaScript to workbook objects. `Excel.Range`, `Excel.Worksheet`, `Excel.Table`, and related variables are local proxy objects, not the live Office objects. Property sets, method calls, and loads queue commands; `context.sync()` dispatches the queue to Excel and returns a Promise when the batch completes. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#request-context); [Excel.RequestContext](https://learn.microsoft.com/en-us/javascript/api/excel/excel.requestcontext?view=excel-js-preview); [Excel.Range](https://learn.microsoft.com/en-us/javascript/api/excel/excel.range?view=excel-js-preview)]

```ts
await Excel.run(async (context: Excel.RequestContext) => {
  const sheet = context.workbook.worksheets.getItem("Data");
  const output = sheet.getRange("D2:D4");

  // This is queued; Excel is changed at sync.
  output.values = [[10], [20], [30]];
  await context.sync();
});
```

`Excel.run` implicitly synchronizes pending commands before resolving, but Microsoft recommends an explicit `await context.sync()` so errors occur at an intentional point and later code cannot accidentally assume an unsynchronized phase. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#sync)]

### Read with `load()` then `sync()`

**Documented requirement/behavior.** Before JavaScript reads a proxy property, explicitly load it and await synchronization. Writes and method calls do not require a prior load. Load leaf properties rather than a parent navigation object; for example, `range.load("format/font/name")` is narrower than loading `format`. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#load); [Application-specific API model: scalar and navigation properties](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#scalar-and-navigation-properties)]

```ts
await Excel.run(async (context) => {
  const range = context.workbook.getSelectedRange();
  range.load(["address", "values"]);
  await context.sync();

  console.log(range.address, range.values);
});
```

For collections, load the item properties needed by every item (`charts.load("name")`). If the code only needs to iterate and set properties, load the collection's `items`. A parameterless `load()` loads all scalar properties and can slow the add-in or exceed service limits; Microsoft explicitly labels it not recommended. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#load-from-a-collection); [Calling `load` without parameters](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#calling-load-without-parameters-not-recommended)]

`ClientResult` values are also synchronization results. For example, `tables.getCount().value` is not available until `context.sync()` completes. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#clientresult)]

### Null-object accessors, `set()`, and writable parents

`getItem()` throws when an item does not exist. A `getItemOrNullObject()` accessor returns a proxy whose `isNullObject` property becomes true after synchronization; it never returns JavaScript `null`, `false`, or `undefined`. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#ornullobject-methods-and-properties)]

Use `set()` when a single object needs several properties, especially nested format properties. Some writable parent properties must be assigned as a complete object (for example, `pageLayout.zoom = { scale: 200 }`) rather than by setting a child path. Consult the member's API reference instead of assuming every navigation path is writable. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#set); [Application-specific API model: properties that cannot be set directly](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#some-properties-cant-be-set-directly)]

### Tracking and context lifetime

`Excel.run` releases objects allocated during its runtime when the run completes. Keep proxies inside the `Excel.run` that created them. If an object must be used across sync calls and outside the normal sequential execution of the run batch, add it to `context.trackedObjects`; remove it when done. `Range.untrack()` is a shortcut for removing that range from the tracked-object list, where supported. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#run-function); [OfficeExtension.TrackedObjects](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.trackedobjects?view=common-js-preview); [ClientRequestContext](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.clientrequestcontext?view=common-js-preview)]

**Documented recommendation.** Explicit untracking is mainly important for very large batches that create thousands of temporary proxies. Untracking is not a substitute for batching or for using block ranges. [Source: [Resource limits and performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/resource-limits-and-performance-optimization#untrack-unneeded-proxy-objects); [Excel performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance)]

**Skill recommendation.** Do not pass a proxy through UI state, a long-lived singleton, or a later `Excel.run` by accident. Return a plain application value/DTO from an Office service, or deliberately track and manage the proxy with its owning context. This follows the documented process and lifetime rules; it is an architecture recommendation, not an extra Office.js requirement. [Underlying source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#request-context)]

## Excel performance and payload shaping

### Batch by phase; avoid `sync()` in loops

**Documented recommendation.** `context.sync()` is the only asynchronous operation in the Excel JavaScript API and can be slow, particularly in Excel on the web. Queue compatible loads and writes and synchronize only at meaningful phases. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#performance-tip-minimize-the-number-of-sync-calls)]

The correlated-objects pattern is the appropriate shape when each Office proxy has associated JavaScript metadata:

1. Load all required host data in one batch and sync.
2. Create JavaScript records such as `{ range, columnName, format }` while correlating each proxy with its metadata.
3. Queue each record's write without synchronizing inside the loop.
4. Sync once for the phase.

The split-loop pattern is the exception for a genuinely large collection: divide it into manageable subsets and sync between subsets. Microsoft explicitly says Excel on the web cannot read more than 5 MB in a `context.sync()` call, but still says not to put a sync in every collection iteration. [Source: [Avoid using the context.sync method in loops](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/correlated-objects-pattern); [Excel performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance)]

### Reduce proxy objects and shape writes

Microsoft's Excel guidance recommends:

- Resolve unchanged objects such as the worksheet outside loops and reuse them.
- Operate on block ranges instead of creating one range proxy per cell.
- Build a two-dimensional JavaScript array, then assign `range.values` once.
- For discontiguous cells, use `RangeAreas` or `getSpecialCells` when a common operation can be expressed once; avoid a `RangeAreas` containing huge numbers of individual cells.

[Source: [Excel performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance); [Work with multiple ranges simultaneously in Excel add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-multiple-ranges)]

`RangeAreas` is a set of non-touching ranges. Setting a property on it sets that property across its areas; when reading, most properties are `null` unless every area has the same value, while booleans are true only when true for every area. Do not mutate `RangeAreas.areas.items` directly. [Source: [Work with multiple ranges simultaneously in Excel add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-multiple-ranges); [Excel.RangeAreas](https://learn.microsoft.com/en-us/javascript/api/excel/excel.rangeareas?view=excel-js-preview)]

### Payload and cell-count limits

**Excel-specific documented limits.** Excel on the web limits each request and response to 5 MB. On all platforms, a range get operation is limited to 5,000,000 cells. A read over that limit can return `null` or throw, so check the range/address before reading `values`. The request payload includes the number of API calls, number of objects (including `Range` objects), and the length of values being set or retrieved. [Source: [Excel performance optimization: payload size limit best practices](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance#payload-size-limit-best-practices); [Resource limits and performance optimization: Excel add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/resource-limits-and-performance-optimization#excel-add-ins)]

If the operation approaches a limit, first reduce loaded properties, proxy count, and value size; only then split into bounded chunks with a sync per sub-operation. `RequestPayloadSizeLimitExceeded` and `ResponsePayloadSizeLimitExceeded` are documented application-specific errors and occur only in Office on the web. [Source: [Error handling with the application-specific JavaScript APIs](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/application-specific-api-error-handling#error-codes-and-messages)]

**Documented client resource limits.** The resource-monitoring defaults for CPU, memory, crashes, and prolonged unresponsiveness apply to Office desktop clients on Windows and Mac, not mobile apps or a browser. The page documents a 90% single-core CPU threshold, a five-second unresponsiveness threshold, and a default crash tolerance of four; treat these as host governance, not as application-level timing guarantees. [Source: [Resource limits and performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/resource-limits-and-performance-optimization#resource-usage-limits-for-add-ins)]

### Suspend expensive Excel processes carefully

For a large update where intermediate formula results are not needed, `Application.suspendApiCalculationUntilNextSync()` suspends formula calculation until the next sync. It does not stop reference rebuilding. `Application.suspendScreenUpdatingUntilNextSync()` suppresses intermediate visual updates until the next sync or end of `Excel.run`; Microsoft warns against calling it repeatedly in a loop because the window can flicker. Provide user progress while the screen is suspended. [Source: [Excel performance optimization: suspend Excel processes](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance#suspend-excel-processes-temporarily)]

Disabling Excel events with `context.runtime.enableEvents` can improve a batch's performance when handlers are not needed. Save the previous state and restore it in cleanup; this save/restore wrapper is a skill recommendation around Microsoft's documented toggle. [Source: [Work with Events using the Excel JavaScript API: enable and disable events](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-events#enable-and-disable-events); [Excel.Runtime](https://learn.microsoft.com/en-us/javascript/api/excel/excel.runtime?view=excel-js-preview)]

## Excel ranges, tables, charts, and other objects

### Object flow and range semantics

The usual Excel object flow is `Workbook` → `Worksheet` → `Range` → (optionally) `Table` or `Chart`. A `Range` is one cell or a contiguous block and is the primary object for values, formulas, and formatting. [Source: [Core Excel object model concepts](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-core-concepts); [Excel.Range](https://learn.microsoft.com/en-us/javascript/api/excel/excel.range?view=excel-js-preview)]

Choose the range selector that matches the task: explicit address, named range, current selection, used range, or (rarely) the whole worksheet. Use explicit bounds for predictable transfer size. [Source: [Get Excel worksheet ranges](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-ranges-get)]

For cell data, choose the property deliberately:

- `range.values` writes raw values and reads calculated results.
- `range.text` reads displayed text as the user sees it.
- `range.formulas` writes formulas and reads formula strings; a non-formula cell returns its raw value in this property.
- Even one cell uses a two-dimensional array such as `[[5]]`.

[Source: [Set or get Excel range values, text, and formulas](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-ranges-set-get-values)]

**Excel-specific caveat.** An unbounded address such as `A:A`, `A:F`, or `2:2` can report metadata such as `address` and `cellCount`, but cell-level reads (`values`, `text`, `numberFormat`, `formulas`) return `null`, and cell-level writes to an unbounded range fail. Narrow to explicit bounds or a suitable used range before transferring cell data. [Source: [Read or write to an unbounded range](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-ranges-unbounded)]

### Tables

Use a `Table` when users need structured data, sorting, filtering, and table formatting. For a large import, Microsoft recommends writing the complete two-dimensional array to a range first and then creating the table over that range. For an existing table, write in bulk to `table.getDataBodyRange()` instead of repeatedly adding rows. [Source: [Create, read, and manage tables](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-tables); [Excel performance optimization: importing data into tables](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance#importing-data-into-tables)]

Use the table's range accessors according to intent: `getHeaderRowRange()`, `getDataBodyRange()`, `getRange()`, and `getTotalRowRange()`. For a filtered table, `getDataBodyRange().getVisibleView()` reads visible cells. Table `onChanged` can report formatting or value changes; inspect its event details when the distinction matters. [Source: [Create, read, and manage tables](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-tables#get-data-from-a-table); [Excel.Table](https://learn.microsoft.com/en-us/javascript/api/excel/excel.table?view=excel-js-preview)]

### Charts

Charts normally start from existing range or table data. Create them with an explicit `Excel.ChartType` and `Excel.ChartSeriesBy`, then set title, legend, axes, position, or series properties in the same batch where possible. `Chart.getImage()` returns a `ClientResult<string>`; await sync before reading its `.value`. [Source: [Create and customize charts](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-charts); [Excel.Chart](https://learn.microsoft.com/en-us/javascript/api/excel/excel.chart?view=excel-js-preview)]

### `RangeAreas` and object existence

Use `RangeAreas` when the same operation applies to several discontiguous regions. Avoid using it as a container for thousands of single-cell objects; use a block range, `getSpecialCells`, or a more selective shape. Use `getItemOrNullObject` when absence is an expected branch, and check `isNullObject` after the required synchronization. [Source: [Work with multiple ranges simultaneously in Excel add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-multiple-ranges); [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#ornullobject-methods-and-properties)]

## Requirement sets and compatibility

### Runtime checks

Requirement sets are named, versioned groups of API members. Support varies by Office application, Office version, platform, and deployment/client channel; a requirement-set version is not an Office.js version and versions for different applications are not interchangeable. [Documented behavior: [Office versions and requirement sets](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/office-versions-and-requirement-sets)]

For Excel, the application-specific requirement-set name is `ExcelApi`. Check optional features after initialization and before the feature path:

```ts
if (Office.context.requirements.isSetSupported("ExcelApi", "1.16")) {
  // Call only APIs documented in ExcelApi 1.16 or earlier.
} else {
  // Keep the useful lower-capability experience.
}
```

The minimum version argument is a string; a numeric literal cannot distinguish versions such as `1.1` and `1.10`. If omitted, the documented default is `1.1`. The method also applies to Common API requirement sets. [Source: [Check for API availability at runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-api-requirements-runtime); [Office.RequirementSetSupport](https://learn.microsoft.com/en-us/javascript/api/office/office.requirementsetsupport?view=common-js-preview)]

A method that is not in a requirement set is a **setless API**. For those, Microsoft documents checking whether the method exists (for example, `if (Office.context.document.setSelectedDataAsync)`) and recommends limiting this style of check. [Source: [Check for API availability at runtime: setless APIs](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-api-requirements-runtime#check-for-setless-api-support)]

Use the API reference for each member's own requirement-set annotation and the [Excel JavaScript API requirement sets](https://learn.microsoft.com/en-us/javascript/api/requirement-sets/excel/excel-api-requirement-sets?view=common-js-preview) availability table for client/build scope. Do not treat a current preview API reference as a production compatibility guarantee.

### Manifest gates and alternate experiences

The add-in-only manifest's `<Hosts>` element controls which Office applications can install the add-in; `<Host Name="Workbook" />` targets Excel, including Excel on the web, Windows, Mac, and iPad. The manifest cannot generally restrict only one platform. [Source: [Specify Office applications and API requirements with the add-in only manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-office-hosts-and-api-requirements#specify-which-office-applications-can-host-your-add-in)]

`<Requirements>`/`<Sets>` specifies minimum capability needed for installation. If a host/platform does not support a base requirement, the add-in will not run there or appear in **My Add-ins**. Microsoft says to put only APIs necessary for significant value in the base manifest; use runtime checks for API-only optional features. Features that require manifest configuration can use a `VersionOverrides` requirement so unsupported clients can still install the add-in while Office ignores that optional markup. [Source: [Specify Office applications and API requirements with the add-in only manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-office-hosts-and-api-requirements#requirements-element); [Design for alternate experiences](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-office-hosts-and-api-requirements#design-for-alternate-experiences)]

**Skill recommendation.** Keep one capability table in the implementation: for every optional operation, record the requirement set/version, supported platforms, fallback, and whether the requirement is in the base manifest or a `VersionOverrides`. This prevents a feature's first call from being the compatibility test. [Underlying sources: [Check for API availability at runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-api-requirements-runtime); [Office client application and platform availability](https://learn.microsoft.com/en-us/javascript/api/requirement-sets)]

## Events and lifecycle

### Excel object events

Excel fires events for changes caused by the Excel UI, Office Add-in JavaScript, and VBA. The object and event determine the payload; examples include workbook/worksheet/table `onChanged`, selection events, calculation events, add/delete events, and chart/worksheet activation events. Do not assume `onChanged` means only a human edit. [Source: [Work with Events using the Excel JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-events#event-triggers)]

Register with an event object's `.add(handler)` and synchronize the request. Remove with the returned event-handler result's `.remove()` and the **same `RequestContext`** used to register it. Event handlers are destroyed when the add-in refreshes, reloads, or closes; they are not stored in the Excel file or preserved across sessions. If the target object is deleted, the handler stops firing but may remain in memory until the add-in/session is refreshed or closed. [Source: [Work with Events using the Excel JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-events#lifecycle-of-an-event-handler)]

With coauthoring, event arguments for events that can be caused by a coauthor expose `event.source`, distinguishing local and remote changes. A handler should be prepared for both. [Source: [Work with Events using the Excel JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-events#events-and-coauthoring)]

Use `context.runtime.enableEvents` to disable/enable JavaScript events around a batch when events are unnecessary or would create avoidable work. Preserve the original setting and restore it; that restoration is a skill-level lifecycle safeguard around the documented toggle. [Source: [Work with Events using the Excel JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-events#enable-and-disable-events)]

An Excel caveat: `onRowHiddenChanged` does not fire when advanced filters hide or show rows; it does fire for standard filters and manual hide/show. [Source: [Work with Events using the Excel JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-events#onrowhiddenchanged-doesnt-fire-for-advanced-filters)]

### Event-based activation is different

Do not conflate an Excel worksheet/workbook event object with **manifest event-based activation**. Event-based activation maps a manifest action to a JavaScript function with `Office.actions.associate`; the handler must signal completion with `event.completed`. The handler is expected to be short-running and lightweight and has an approximately 300-second maximum in the documented runtime. For Excel/PowerPoint/Word event-based handlers, UI APIs are not supported in the JavaScript-only runtime; on Windows, the event handler's startup code in `Office.onReady()`/`Office.initialize` is not run, so perform required startup checks inside that handler. Confirm the current client/platform matrix before enabling it. [Source: [Activate add-ins with events](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/event-based-activation#overview); [Behavior and limitations](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/event-based-activation#behavior-and-limitations); [Runtimes in Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/runtimes)]

## Error handling, diagnostics, and debugging

### Catch the run and inspect structured errors

**Documented recommendation.** Every application-specific `Excel.run`/`Word.run`/`PowerPoint.run` operation in Microsoft's samples is accompanied by a catch. Await the sync inside the try block so the rejected Promise is caught at the operation boundary. [Source: [Error handling with the application-specific JavaScript APIs](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/application-specific-api-error-handling#best-practices)]

```ts
try {
  await Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load("values");
    await context.sync();
    // Use range.values only after the awaited sync.
  });
} catch (error: unknown) {
  const officeError = error as OfficeExtension.Error;
  console.error(officeError.code, officeError.debugInfo);
  // Map the code to a user-facing message; do not show raw diagnostics.
}
```

`OfficeExtension.Error.code` is a stable, nonlocalized identifier. `message` is a localized summary intended for diagnostics, not for application logic or direct end-user display. `debugInfo` can include `errorLocation`, `statement`, `surroundingStatements`, and `fullStatements`; the API reference warns that `fullStatements` can contain potentially sensitive request data, while the statement/surrounding statements are designed not to. [Source: [Error handling with the application-specific JavaScript APIs](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/application-specific-api-error-handling#error-codes-and-messages); [OfficeExtension.Error](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.error?view=common-js-preview); [OfficeExtension.DebugInfo](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.debuginfo?view=common-js-preview)]

Use the code to decide behavior (`ItemNotFound`, `InvalidReference`, `InvalidSelection`, `ApiNotFound`, `RequestPayloadSizeLimitExceeded`, and similar documented codes) and provide a separate friendly message. Do not parse localized error text. [Source: [Error handling with the application-specific JavaScript APIs](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/application-specific-api-error-handling#error-codes-and-messages)]

### Trace queued batches

`context.trace("checkpoint")` queues a trace message. If the following `context.sync()` rejects, `error.traceMessages` contains the trace messages executed before the failure. Tracing is a batch diagnostic, not an immediate browser-console write. [Source: [OfficeExtension.ClientRequestContext](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.clientrequestcontext?view=common-js-preview); [OfficeExtension.Error](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.error?view=common-js-preview)]

**Privacy rule.** Log host, platform, API requirement, operation name, error code, and carefully redacted diagnostics. Avoid sending `debugInfo.fullStatements`, workbook values, or formulas to telemetry without an explicit data review. [Source: [OfficeExtension.DebugInfo](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.debuginfo?view=common-js-preview)]

### Runtime logging and developer tools

Runtime logging is for host-level diagnostics such as manifest parsing, loading, and initialization conditions; it does not capture `console.log()` output and affects performance, so enable it only while investigating a manifest/host issue and then disable it. Use the platform's WebView/browser developer tools for JavaScript and TypeScript debugging. [Source: [Debug your add-in with runtime logging](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/runtime-logging); [Debug Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/debug-add-ins-overview)]

## Async patterns, cancellation, and timeouts

### Application-specific and Common API styles

The application-specific model is Promise-based; use `async`/`await` and always return/await the `Excel.run` and `context.sync` Promises. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model)]

Common API methods ending in `Async` invoke immediately and deliver one `AsyncResult` to their callback. Check `result.status` before reading `result.value`, and use `result.error` on failure. In the documented current Common API model, built-in Promise support is limited to bindings in Excel/Word; wrap other callback-based methods in your own Promise when an `await`-based control flow is required. [Source: [Asynchronous programming in Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/asynchronous-programming-in-office-add-ins)]

```ts
function getSelectedText(): Promise<string> {
  return new Promise((resolve, reject) => {
    Office.context.document.getSelectedDataAsync(
      Office.CoercionType.Text,
      (result: Office.AsyncResult<string>) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          resolve(result.value);
        } else {
          reject(result.error);
        }
      }
    );
  });
}
```

Optional parameters for Common API async methods are an object of named values; `asyncContext` can carry caller state to the callback. [Source: [Asynchronous programming in Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/asynchronous-programming-in-office-add-ins#pass-optional-parameters-to-asynchronous-methods)]

### What is and is not cancellable

**Documented API surface.** The `ClientRequestContext.sync` signature is `sync<T>(passThroughValue?: T): Promise<T>`; the referenced API does not expose an `AbortSignal`, cancellation token, or timeout parameter. Microsoft documents no general-purpose cancellation contract for ordinary `Excel.run`/`context.sync` or callback-style Common API operations in the cited guidance. This is an observation of the published API surface, not a promise that every future API will remain unchanged. [Source: [OfficeExtension.ClientRequestContext](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.clientrequestcontext?view=common-js-preview); [Asynchronous programming in Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/asynchronous-programming-in-office-add-ins)]

**Skill recommendation.** If a UI needs a deadline, an application-level timer may stop waiting and report status, but it must not be described as aborting an already queued host request. Use operation IDs/stale-result guards before applying late UI state, and avoid blindly issuing a duplicate write. This is application policy, not an Office.js cancellation feature.

**Excel custom-function exception.** External-data custom functions return a Promise for one-time results. Streaming functions use `onCanceled` for cleanup. A one-result asynchronous custom function can use the `@cancelable` tag and `CustomFunctions.CancelableInvocation`; streaming and cancelable functions are distinct. Excel can cancel when inputs change or recalculation occurs, and cancellation/new-invocation ordering is not guaranteed, so cleanup must safely clear timers, close connections, and abort pending external requests. [Source: [Receive and handle data with custom functions](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs#cancel-a-function)]

## Authentication, security, manifests, and runtimes (Office.js-specific)

This section intentionally stays within Office.js/add-in concerns rather than general web security.

### Manifest and transport boundaries

Every Office Add-in has a manifest that declares its identity, integration, permissions, hosts, URLs, and (where used) requirements. Add-in code/content URLs should use HTTPS; SSL is required for Office on the web and Microsoft Marketplace publishing, and is strongly recommended for other deployments. [Source: [Office Add-ins manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/add-in-manifests); [Specify Office applications and API requirements with the add-in only manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-office-hosts-and-api-requirements)]

On desktop, navigation to another domain in the root task pane opens outside the pane unless the domain is declared in the manifest. An iframe that needs to call Office.js must have its source domain listed; an undeclared iframe receives a permission-denied error. [Source: [Office Add-ins manifest: specify domains](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/add-in-manifests#specify-domains-you-want-to-open-in-the-add-in-window)]

Load Office.js from Microsoft's HTTPS CDN rather than copying/bundling it. Use the production endpoint for production and the beta endpoint only for preview work. [Source: [Referencing the Office JavaScript API library](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/referencing-the-javascript-api-for-office-library-from-its-cdn)]

### Runtime choice affects available APIs and state

Office uses:

- a **JavaScript-only runtime** for certain background/event/custom-function scenarios; it has WebSockets, full CORS, and OfficeRuntime storage but no HTML renderer, cookies, or `localStorage`;
- a **browser runtime** for task panes/dialogs and other UI scenarios; it adds HTML rendering, cookies, and `localStorage`;
- an optional **shared runtime** (a browser-type runtime) in Excel, PowerPoint, and Word, allowing selected features such as a task pane, function commands, and Excel custom functions to share a process.

Runtimes can be separate even within one add-in, and feature/platform combinations differ. Do not assume a task-pane global, DOM, cookie, or local storage is available to a custom function or event handler. [Source: [Runtimes in Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/runtimes); [Configure your Office Add-in to use a shared runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime)]

For an Excel custom function without a shared runtime, Microsoft documents using `OfficeRuntime.displayWebDialog` for sign-in and `OfficeRuntime.storage` to cache/share a token. That JavaScript-only runtime has no `localStorage`; Microsoft specifically warns that document settings are not secure for this information because users of the add-in can extract it. [Source: [Authentication for custom functions without a shared runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-authentication)]

**Skill recommendation.** At the start of each feature implementation, record its runtime (task pane, shared runtime, JavaScript-only custom function, dialog, or event handler), its available UI/storage APIs, and its manifest/runtime requirement. This prevents an agent from copying task-pane code into a background runtime where it cannot execute. [Underlying source: [Runtimes in Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/runtimes)]

## TypeScript and API design

### TypeScript mechanics

Microsoft's current guidance uses `@types/office-js` for IntelliSense/type checking and keeps the runtime global: load Office.js from the CDN; do not import or bundle the runtime in TypeScript. [Source: [Connect Office.js to any JavaScript framework: TypeScript support](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/connect-to-javascript-frameworks#typescript-support); [Referencing the Office JavaScript API library: IntelliSense](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/referencing-the-javascript-api-for-office-library-from-its-cdn#enabling-intellisense-for-a-typescript-project)]

```ts
Office.onReady((info: Office.OfficeInfo) => {
  if (info.host === Office.HostType.Excel) {
    // Office is initialized; Excel types are available to this code.
  }
});

async function writeCell(value: string): Promise<void> {
  await Excel.run(async (context: Excel.RequestContext) => {
    const cell = context.workbook.getSelectedRange();
    cell.values = [[value]];
    await context.sync();
  });
}
```

Keep requirement-set version strings as strings and use the generated Office types for host objects. Treat `unknown` errors as a boundary and extract documented fields only after checking the error shape; do not cast away a missing API and call it anyway. The last two points are skill recommendations based on the documented capability/error contracts. [Underlying sources: [Check for API availability at runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-api-requirements-runtime); [OfficeExtension.Error](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.error?view=common-js-preview)]

### A maintainable boundary

**Skill recommendation.** Put Office calls in small host-specific services:

- accept plain inputs such as worksheet/table names, addresses, and data matrices;
- create/use proxies only within one `Excel.run` where practical;
- group loads and writes around explicit sync phases;
- return plain values/DTOs to business logic and UI;
- expose a capability check alongside optional operations;
- keep Common API wrappers separate from Excel object-model services.

This boundary is not an Office.js requirement; it is a direct way to respect the documented request-context, proxy, and lifetime model while making non-Office code testable. [Underlying sources: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model); [Common JavaScript API object model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/office-javascript-api-object-model)]

## Cross-Office generalization

The batching mental model transfers to Word, PowerPoint, OneNote, and Visio application-specific APIs: a `*.run` method supplies a request context, proxy operations queue, and `sync()` returns loaded properties. It does **not** transfer Excel object names or semantics; use the host's own API reference and requirement set. Outlook and Project require the Common API model instead. [Source: [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model); [Office versions and requirement sets](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/office-versions-and-requirement-sets)]

Common APIs are the portable layer for runtime context, host/platform information, dialogs, settings, bindings, and file access, but individual Common API members still have requirement sets or platform limitations. Use `Office.context.requirements.isSetSupported` and the API reference for each member. [Source: [Common JavaScript API object model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/office-javascript-api-object-model); [Office Common API requirement sets](https://learn.microsoft.com/en-us/javascript/api/requirement-sets/common/office-add-in-requirement-sets?view=common-js-preview)]

**Skill recommendation.** Share initialization, capability, async-result, error, and diagnostics helpers across hosts; keep `Excel.run`/`Word.run`/`PowerPoint.run` adapters and object-specific data shaping separate. Test the same scenario on every declared host/platform rather than treating one desktop Excel run as cross-Office evidence. [Underlying sources: [Office client application and platform availability](https://learn.microsoft.com/en-us/javascript/api/requirement-sets); [Understand the Office JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/understand-the-javascript-api-for-office)]

## Anti-patterns and replacements

| Anti-pattern | Why it fails or costs | Replacement |
|---|---|---|
| Calling Office APIs while modules are loading | The Office runtime may not be initialized. | Load Office.js in `<head>` and start Office-dependent code from `Office.onReady()`. [Initialize](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/initialize-add-in) |
| Assigning `Office.initialize` late or assuming it is repeatable | It has one handler and can be missed; it is the legacy mechanism. | Use `Office.onReady()` for new code. [Initialize](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/initialize-add-in#major-differences-between-officeinitialize-and-officeonready) |
| Using host/platform strings as feature support | Host identity does not encode requirement-set support. | Check the named requirement set/API and provide a fallback. [Runtime availability](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-api-requirements-runtime) |
| Calling `context.sync()` once per loop item/cell | Each sync is a host round trip and is especially costly on the web. | Batch, use correlated objects, then sync by phase; chunk only for limits. [Correlated objects](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/correlated-objects-pattern) |
| Building one enormous batch with broad loads | Payload/object/property volume can exceed limits. | Load leaf properties, reduce proxies, use bounded chunks. [Excel performance](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance) |
| Calling parameterless `load()` | It retrieves unnecessary scalar data and can hit service limits. | Name only the properties the code reads. [Application-specific model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#calling-load-without-parameters-not-recommended) |
| Reading an unloaded property or `ClientResult.value` before sync | The proxy has not received the value. | `load(...)`; await `context.sync()`; then read. [Application-specific model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#load) |
| Passing untracked proxies between runs/UI state | The owning context/runtime may have released the object. | Return plain data, or deliberately track and remove the object. [TrackedObjects](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.trackedobjects?view=common-js-preview) |
| Calling `untrack()` on everything | It adds lifecycle work without the documented benefit for normal-sized operations. | Use it for thousands of temporary proxies; otherwise let the run manage lifetime. [Resource limits](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/resource-limits-and-performance-optimization#untrack-unneeded-proxy-objects) |
| Reading/writing `A:A`, `A:F`, or `2:2` as cell data | Unbounded cell properties read as null and writes fail. | Use explicit bounds or narrow the used range. [Unbounded ranges](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-ranges-unbounded) |
| Adding large tables row by row | It degrades performance for large imports. | Write an array to a range, create the table, or bulk-write its data body. [Excel performance](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance#importing-data-into-tables) |
| Assuming `onChanged` is user-only or event handlers persist | Add-in JS/VBA also trigger events; handlers are session-scoped. | Account for source/lifecycle, and remove with the original context. [Excel events](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-events) |
| Disabling events without restoring them | Later code may unexpectedly stop receiving events. | Save/restore `context.runtime.enableEvents` in cleanup. [Excel events](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-events#enable-and-disable-events) |
| Showing `error.message` as stable logic or user contract | Messages are localized and not intended for end users. | Branch on `error.code`; log redacted diagnostics; show a friendly message. [Error handling](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/application-specific-api-error-handling#error-codes-and-messages) |
| Sending `debugInfo.fullStatements` or workbook data to telemetry | Full statements may contain sensitive request data. | Redact; retain only the minimum diagnostics needed. [DebugInfo](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.debuginfo?view=common-js-preview) |
| Using task-pane DOM/localStorage code in a JavaScript-only runtime | That runtime has no renderer, cookies, or localStorage. | Use runtime-appropriate APIs; for non-shared custom-function auth use `OfficeRuntime.storage`/`displayWebDialog`. [Runtimes](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/runtimes); [Custom-function authentication](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-authentication) |
| Treating a Promise timeout as host cancellation | Ordinary `sync()` has no cancellation-token/timeout parameter. | Use an app-level deadline only as a caller/UI policy; use documented `onCanceled` for cancelable custom functions. [ClientRequestContext](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.clientrequestcontext?view=common-js-preview); [Custom functions](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs#cancel-a-function) |
| Deploying `office.debug.js` or preview APIs as production contracts | Debug/preview endpoints are for development/preview scope. | Use production CDN/requirement-set APIs in production. [CDN reference](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/referencing-the-javascript-api-for-office-library-from-its-cdn); [Debugging](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/debug-add-ins-overview) |

## Concise checklist for conversion into `SKILL.md`

- [ ] Load `https://appsforoffice.microsoft.com/lib/1/hosted/office.js` in `<head>` before app bundles; never bundle the runtime.
- [ ] Await `Office.onReady()`; handle browser mode where `host`/`platform` are null.
- [ ] Branch by `Office.HostType`/`PlatformType` only for host behavior; gate APIs with requirement sets or documented setless checks.
- [ ] Keep the base manifest requirement to capabilities essential to any useful experience; use runtime/`VersionOverrides` fallbacks for optional features.
- [ ] Use Excel's application-specific model for workbook work; use Common APIs only for shared/uncovered scenarios.
- [ ] Put each logical Excel operation in `Excel.run`; use its `RequestContext` and await every needed `context.sync()`.
- [ ] Load only the leaf properties JavaScript reads; never read a proxy/`ClientResult` before sync.
- [ ] Batch independent reads/writes; reuse proxies and write bounded two-dimensional arrays instead of cell-by-cell loops.
- [ ] Avoid `sync()` in loops; use correlated objects, then chunk only when payload/cell limits demand it.
- [ ] Keep ranges bounded; remember Excel web 5 MB request/response and 5,000,000-cell get limits.
- [ ] Track proxies only when they must cross sync/run boundaries; untrack/remove long-lived or very numerous proxies when finished.
- [ ] Use table body/header ranges and bulk table import; create/configure charts from explicit ranges and sync `ClientResult` values.
- [ ] Register/remove Excel events with the same context; account for add-in/VBA/coauthor sources and session-only lifetime; restore event-enable state.
- [ ] Catch `Excel.run`/`sync()` failures; branch on `error.code`, inspect redacted `debugInfo`/`traceMessages`, and keep raw diagnostics out of user UI.
- [ ] Wrap callback-style Common APIs in Promises only when needed; use `AsyncResult.status`/`error` correctly.
- [ ] Do not promise cancellation for ordinary Office calls; use documented custom-function `onCanceled`/`@cancelable` semantics and cleanup external work.
- [ ] Record runtime type and test every declared host/platform; JavaScript-only runtimes lack DOM/cookies/localStorage.

## Source list

All sources below are first-party Microsoft Learn or Microsoft/OfficeDev primary sources and were accessed **2026-09-16**.

### Core lifecycle, models, and compatibility

- [Initialize your Office Add-in](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/initialize-add-in)
- [Loading the DOM and runtime environment](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/loading-the-dom-and-runtime-environment)
- [Referencing the Office JavaScript API library](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/referencing-the-javascript-api-for-office-library-from-its-cdn)
- [Connect Office.js to any JavaScript framework](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/connect-to-javascript-frameworks)
- [Understand the Office JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/understand-the-javascript-api-for-office)
- [Application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model)
- [Common JavaScript API object model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/office-javascript-api-object-model)
- [Office versions and requirement sets](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/office-versions-and-requirement-sets)
- [Check for API availability at runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-api-requirements-runtime)
- [Specify Office applications and API requirements with the add-in only manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-office-hosts-and-api-requirements)
- [Excel JavaScript API requirement sets](https://learn.microsoft.com/en-us/javascript/api/requirement-sets/excel/excel-api-requirement-sets?view=common-js-preview)
- [Office Common API requirement sets](https://learn.microsoft.com/en-us/javascript/api/requirement-sets/common/office-add-in-requirement-sets?view=common-js-preview)
- [Office client application and platform availability](https://learn.microsoft.com/en-us/javascript/api/requirement-sets)

### Office.js API reference

- [Office.Context](https://learn.microsoft.com/en-us/javascript/api/office/office.context?view=common-js-preview)
- [Office.ContextInformation](https://learn.microsoft.com/en-us/javascript/api/office/office.contextinformation?view=common-js-preview)
- [Office.HostType](https://learn.microsoft.com/en-us/javascript/api/office/office.hosttype?view=common-js-preview)
- [Office.PlatformType](https://learn.microsoft.com/en-us/javascript/api/office/office.platformtype?view=common-js-preview)
- [Office.RequirementSetSupport](https://learn.microsoft.com/en-us/javascript/api/office/office.requirementsetsupport?view=common-js-preview)
- [OfficeExtension.ClientRequestContext](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.clientrequestcontext?view=common-js-preview)
- [OfficeExtension.TrackedObjects](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.trackedobjects?view=common-js-preview)
- [OfficeExtension.Error](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.error?view=common-js-preview)
- [OfficeExtension.DebugInfo](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.debuginfo?view=common-js-preview)
- [Excel.RequestContext](https://learn.microsoft.com/en-us/javascript/api/excel/excel.requestcontext?view=excel-js-preview)
- [Excel.Runtime](https://learn.microsoft.com/en-us/javascript/api/excel/excel.runtime?view=excel-js-preview)
- [Excel.Range](https://learn.microsoft.com/en-us/javascript/api/excel/excel.range?view=excel-js-preview)
- [Excel.RangeAreas](https://learn.microsoft.com/en-us/javascript/api/excel/excel.rangeareas?view=excel-js-preview)
- [Excel.Table](https://learn.microsoft.com/en-us/javascript/api/excel/excel.table?view=excel-js-preview)
- [Excel.Chart](https://learn.microsoft.com/en-us/javascript/api/excel/excel.chart?view=excel-js-preview)

### Excel operations, performance, events, and async

- [Core Excel object model concepts](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-core-concepts)
- [Get Excel worksheet ranges](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-ranges-get)
- [Set or get Excel range values, text, and formulas](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-ranges-set-get-values)
- [Read or write to an unbounded range](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-ranges-unbounded)
- [Create, read, and manage tables](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-tables)
- [Create and customize charts](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-charts)
- [Work with multiple ranges simultaneously](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-multiple-ranges)
- [Excel performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/performance)
- [Avoid using the context.sync method in loops](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/correlated-objects-pattern)
- [Resource limits and performance optimization](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/resource-limits-and-performance-optimization)
- [Work with Events using the Excel JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-events)
- [Activate add-ins with events](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/event-based-activation)
- [Asynchronous programming in Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/asynchronous-programming-in-office-add-ins)
- [Receive and handle data with custom functions](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs)

### Errors, debugging, manifests, and runtimes

- [Error handling with the application-specific JavaScript APIs](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/application-specific-api-error-handling)
- [Debug your add-in with runtime logging](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/runtime-logging)
- [Debug Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/debug-add-ins-overview)
- [Runtimes in Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/runtimes)
- [Configure your Office Add-in to use a shared runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/configure-your-add-in-to-use-a-shared-runtime)
- [Office Add-ins manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/add-in-manifests)
- [Authentication for custom functions without a shared runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-authentication)

### Official Microsoft source repositories

- [OfficeDev/office-js-docs-pr](https://github.com/OfficeDev/office-js-docs-pr) — source repository for the Microsoft Learn Office Add-ins documentation cited above.
- [OfficeDev/Office-Add-in-samples](https://github.com/OfficeDev/Office-Add-in-samples) — first-party Office Add-in samples referenced by the documentation.
- [OfficeDev/office-js](https://github.com/OfficeDev/office-js) — first-party Office.js repository and license/source material.
