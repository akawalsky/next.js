import type { IncomingMessage, ServerResponse } from 'http'
import type {
  ActionResult,
  DynamicParamTypesShort,
  FlightData,
  FlightRouterState,
  FlightSegmentPath,
  RenderOpts,
  Segment,
  CacheNodeSeedData,
} from './types'
import type { StaticGenerationStore } from '../../client/components/static-generation-async-storage.external'
import type { RequestStore } from '../../client/components/request-async-storage.external'
import type { NextParsedUrlQuery } from '../request-meta'
import type { LoaderTree } from '../lib/app-dir-module'
import type { AppPageModule } from '../future/route-modules/app-page/module'
import type { ClientReferenceManifest } from '../../build/webpack/plugins/flight-manifest-plugin'
import type { Revalidate } from '../lib/revalidate'

import React from 'react'

import {
  createServerComponentRenderer,
  type ServerComponentRendererOptions,
} from './create-server-components-renderer'
import RenderResult, {
  type AppPageRenderResultMetadata,
  type RenderResultOptions,
  type RenderResultResponse,
} from '../render-result'
import {
  renderToInitialFizzStream,
  continueFizzStream,
  cloneTransformStream,
  type ContinueStreamOptions,
  continuePostponedFizzStream,
} from '../stream-utils/node-web-streams-helper'
import { canSegmentBeOverridden } from '../../client/components/match-segments'
import { stripInternalQueries } from '../internal-utils'
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE,
  RSC_HEADER,
} from '../../client/components/app-router-headers'
import { createMetadataComponents } from '../../lib/metadata/metadata'
import { RequestAsyncStorageWrapper } from '../async-storage/request-async-storage-wrapper'
import { StaticGenerationAsyncStorageWrapper } from '../async-storage/static-generation-async-storage-wrapper'
import { isNotFoundError } from '../../client/components/not-found'
import {
  getURLFromRedirectError,
  isRedirectError,
  getRedirectStatusCodeFromError,
} from '../../client/components/redirect'
import { addImplicitTags } from '../lib/patch-fetch'
import { AppRenderSpan } from '../lib/trace/constants'
import { getTracer } from '../lib/trace/tracer'
import { FlightRenderResult } from './flight-render-result'
import { createErrorHandler, type ErrorHandler } from './create-error-handler'
import {
  getShortDynamicParamType,
  dynamicParamTypes,
} from './get-short-dynamic-param-type'
import { getSegmentParam } from './get-segment-param'
import { getScriptNonceFromHeader } from './get-script-nonce-from-header'
import { parseAndValidateFlightRouterState } from './parse-and-validate-flight-router-state'
import { validateURL } from './validate-url'
import { createFlightRouterStateFromLoaderTree } from './create-flight-router-state-from-loader-tree'
import { handleAction } from './action-handler'
import { NEXT_DYNAMIC_NO_SSR_CODE } from '../../shared/lib/lazy-dynamic/no-ssr-error'
import { warn, error } from '../../build/output/log'
import { appendMutableCookies } from '../web/spec-extension/adapters/request-cookies'
import { createServerInsertedHTML } from './server-inserted-html'
import { getRequiredScripts } from './required-scripts'
import { addPathPrefix } from '../../shared/lib/router/utils/add-path-prefix'
import { makeGetServerInsertedHTML } from './make-get-server-inserted-html'
import { walkTreeWithFlightRouterState } from './walk-tree-with-flight-router-state'
import { createComponentTree } from './create-component-tree'
import { getAssetQueryString } from './get-asset-query-string'
import { setReferenceManifestsSingleton } from './action-encryption-utils'
import { createStaticRenderer } from './static/static-renderer'
import { MissingPostponeDataError } from './is-missing-postpone-error'
import { DetachedPromise } from '../../lib/detached-promise'
import { DYNAMIC_ERROR_CODE } from '../../client/components/hooks-server-context'

export type GetDynamicParamFromSegment = (
  // [slug] / [[slug]] / [...slug]
  segment: string
) => {
  param: string
  value: string | string[] | null
  treeSegment: Segment
  type: DynamicParamTypesShort
} | null

type AppRenderBaseContext = {
  staticGenerationStore: StaticGenerationStore
  requestStore: RequestStore
  componentMod: AppPageModule
  renderOpts: RenderOpts
}

export type GenerateFlight = typeof generateFlight

export type AppRenderContext = AppRenderBaseContext & {
  getDynamicParamFromSegment: GetDynamicParamFromSegment
  query: NextParsedUrlQuery
  isPrefetch: boolean
  providedSearchParams: NextParsedUrlQuery
  requestTimestamp: number
  searchParamsProps: { searchParams: NextParsedUrlQuery }
  appUsingSizeAdjustment: boolean
  providedFlightRouterState?: FlightRouterState
  requestId: string
  defaultRevalidate: Revalidate
  pagePath: string
  clientReferenceManifest: ClientReferenceManifest
  assetPrefix: string
  flightDataRendererErrorHandler: ErrorHandler
  serverComponentsErrorHandler: ErrorHandler
  isNotFoundPath: boolean
  res: ServerResponse
}

function createNotFoundLoaderTree(loaderTree: LoaderTree): LoaderTree {
  // Align the segment with parallel-route-default in next-app-loader
  return ['', {}, loaderTree[2]]
}

/* This method is important for intercepted routes to function:
 * when a route is intercepted, e.g. /blog/[slug], it will be rendered
 * with the layout of the previous page, e.g. /profile/[id]. The problem is
 * that the loader tree needs to know the dynamic param in order to render (id and slug in the example).
 * Normally they are read from the path but since we are intercepting the route, the path would not contain id,
 * so we need to read it from the router state.
 */
function findDynamicParamFromRouterState(
  providedFlightRouterState: FlightRouterState | undefined,
  segment: string
): {
  param: string
  value: string | string[] | null
  treeSegment: Segment
  type: DynamicParamTypesShort
} | null {
  if (!providedFlightRouterState) {
    return null
  }

  const treeSegment = providedFlightRouterState[0]

  if (canSegmentBeOverridden(segment, treeSegment)) {
    if (!Array.isArray(treeSegment) || Array.isArray(segment)) {
      return null
    }

    return {
      param: treeSegment[0],
      value: treeSegment[1],
      treeSegment: treeSegment,
      type: treeSegment[2],
    }
  }

  for (const parallelRouterState of Object.values(
    providedFlightRouterState[1]
  )) {
    const maybeDynamicParam = findDynamicParamFromRouterState(
      parallelRouterState,
      segment
    )
    if (maybeDynamicParam) {
      return maybeDynamicParam
    }
  }

  return null
}

export type CreateSegmentPath = (child: FlightSegmentPath) => FlightSegmentPath

/**
 * Returns a function that parses the dynamic segment and return the associated value.
 */
function makeGetDynamicParamFromSegment(
  params: { [key: string]: any },
  providedFlightRouterState: FlightRouterState | undefined
): GetDynamicParamFromSegment {
  return function getDynamicParamFromSegment(
    // [slug] / [[slug]] / [...slug]
    segment: string
  ) {
    const segmentParam = getSegmentParam(segment)
    if (!segmentParam) {
      return null
    }

    const key = segmentParam.param

    let value = params[key]

    // this is a special marker that will be present for interception routes
    if (value === '__NEXT_EMPTY_PARAM__') {
      value = undefined
    }

    if (Array.isArray(value)) {
      value = value.map((i) => encodeURIComponent(i))
    } else if (typeof value === 'string') {
      value = encodeURIComponent(value)
    }

    if (!value) {
      // Handle case where optional catchall does not have a value, e.g. `/dashboard/[...slug]` when requesting `/dashboard`
      if (segmentParam.type === 'optional-catchall') {
        const type = dynamicParamTypes[segmentParam.type]
        return {
          param: key,
          value: null,
          type: type,
          // This value always has to be a string.
          treeSegment: [key, '', type],
        }
      }
      return findDynamicParamFromRouterState(providedFlightRouterState, segment)
    }

    const type = getShortDynamicParamType(segmentParam.type)

    return {
      param: key,
      // The value that is passed to user code.
      value: value,
      // The value that is rendered in the router tree.
      treeSegment: [key, Array.isArray(value) ? value.join('/') : value, type],
      type: type,
    }
  }
}

// Handle Flight render request. This is only used when client-side navigating. E.g. when you `router.push('/dashboard')` or `router.reload()`.
async function generateFlight(
  ctx: AppRenderContext,
  options?: {
    actionResult: ActionResult
    skipFlight: boolean
    asNotFound?: boolean
  }
): Promise<RenderResult> {
  // Flight data that is going to be passed to the browser.
  // Currently a single item array but in the future multiple patches might be combined in a single request.
  let flightData: FlightData | null = null

  const {
    componentMod: { tree: loaderTree, renderToReadableStream },
    getDynamicParamFromSegment,
    appUsingSizeAdjustment,
    staticGenerationStore: { urlPathname },
    providedSearchParams,
    requestId,
    providedFlightRouterState,
  } = ctx

  if (!options?.skipFlight) {
    const [MetadataTree, MetadataOutlet] = createMetadataComponents({
      tree: loaderTree,
      pathname: urlPathname,
      searchParams: providedSearchParams,
      getDynamicParamFromSegment,
      appUsingSizeAdjustment,
    })
    flightData = (
      await walkTreeWithFlightRouterState({
        ctx,
        createSegmentPath: (child) => child,
        loaderTreeToFilter: loaderTree,
        parentParams: {},
        flightRouterState: providedFlightRouterState,
        isFirst: true,
        // For flight, render metadata inside leaf page
        rscPayloadHead: (
          // Adding requestId as react key to make metadata remount for each render
          <MetadataTree key={requestId} />
        ),
        injectedCSS: new Set(),
        injectedJS: new Set(),
        injectedFontPreloadTags: new Set(),
        rootLayoutIncluded: false,
        asNotFound: ctx.isNotFoundPath || options?.asNotFound,
        metadataOutlet: <MetadataOutlet />,
      })
    ).map((path) => path.slice(1)) // remove the '' (root) segment
  }

  const buildIdFlightDataPair = [ctx.renderOpts.buildId, flightData]

  // For app dir, use the bundled version of Flight server renderer (renderToReadableStream)
  // which contains the subset React.
  const flightReadableStream = renderToReadableStream(
    options
      ? [options.actionResult, buildIdFlightDataPair]
      : buildIdFlightDataPair,
    ctx.clientReferenceManifest.clientModules,
    {
      onError: ctx.flightDataRendererErrorHandler,
    }
  )

  return new FlightRenderResult(flightReadableStream)
}

/**
 * Creates a resolver that eagerly generates a flight payload that is then
 * resolved when the resolver is called.
 */
function createFlightDataResolver(ctx: AppRenderContext) {
  // Generate the flight data and as soon as it can, convert it into a string.
  const promise = generateFlight(ctx)
    .then(async (result) => ({
      flightData: await result.toUnchunkedString(true),
    }))
    // Otherwise if it errored, return the error.
    .catch((err) => ({ err }))

  return async () => {
    // Resolve the promise to get the flight data or error.
    const result = await promise

    // If the flight data failed to render due to an error, re-throw the error
    // here.
    if ('err' in result) {
      throw result.err
    }

    // Otherwise, return the flight data.
    return result.flightData
  }
}

type ServerComponentsRendererOptions = {
  ctx: AppRenderContext
  preinitScripts: () => void
  options: ServerComponentRendererOptions
}

/**
 * A new React Component that renders the provided React Component
 * using Flight which can then be rendered to HTML.
 */
function createServerComponentsRenderer(
  loaderTreeToRender: LoaderTree,
  { ctx, preinitScripts, options }: ServerComponentsRendererOptions
) {
  return createServerComponentRenderer<{
    asNotFound: boolean
  }>(async (props) => {
    preinitScripts()
    // Create full component tree from root to leaf.
    const injectedCSS = new Set<string>()
    const injectedJS = new Set<string>()
    const injectedFontPreloadTags = new Set<string>()
    const {
      getDynamicParamFromSegment,
      query,
      providedSearchParams,
      appUsingSizeAdjustment,
      componentMod: { AppRouter, GlobalError },
      staticGenerationStore: { urlPathname },
    } = ctx
    const initialTree = createFlightRouterStateFromLoaderTree(
      loaderTreeToRender,
      getDynamicParamFromSegment,
      query
    )

    const [MetadataTree, MetadataOutlet] = createMetadataComponents({
      tree: loaderTreeToRender,
      errorType: props.asNotFound ? 'not-found' : undefined,
      pathname: urlPathname,
      searchParams: providedSearchParams,
      getDynamicParamFromSegment: getDynamicParamFromSegment,
      appUsingSizeAdjustment: appUsingSizeAdjustment,
    })

    const { seedData, styles } = await createComponentTree({
      ctx,
      createSegmentPath: (child) => child,
      loaderTree: loaderTreeToRender,
      parentParams: {},
      firstItem: true,
      injectedCSS,
      injectedJS,
      injectedFontPreloadTags,
      rootLayoutIncluded: false,
      asNotFound: props.asNotFound,
      metadataOutlet: <MetadataOutlet />,
    })

    return (
      <>
        {styles}
        <AppRouter
          buildId={ctx.renderOpts.buildId}
          assetPrefix={ctx.assetPrefix}
          initialCanonicalUrl={urlPathname}
          // This is the router state tree.
          initialTree={initialTree}
          // This is the tree of React nodes that are seeded into the cache
          initialSeedData={seedData}
          initialHead={
            <>
              {ctx.res.statusCode > 400 && (
                <meta name="robots" content="noindex" />
              )}
              {/* Adding requestId as react key to make metadata remount for each render */}
              <MetadataTree key={ctx.requestId} />
            </>
          }
          globalErrorComponent={GlobalError}
        />
      </>
    )
  }, options)
}

async function renderToHTMLOrFlightImpl(
  req: IncomingMessage,
  res: ServerResponse,
  pagePath: string,
  query: NextParsedUrlQuery,
  renderOpts: RenderOpts,
  baseCtx: AppRenderBaseContext
) {
  const isNotFoundPath = pagePath === '/404'

  // A unique request timestamp used by development to ensure that it's
  // consistent and won't change during this request. This is important to
  // avoid that resources can be deduped by React Float if the same resource is
  // rendered or preloaded multiple times: `<link href="a.css?v={Date.now()}"/>`.
  const requestTimestamp = Date.now()

  const {
    buildManifest,
    subresourceIntegrityManifest,
    serverActionsManifest,
    ComponentMod,
    dev,
    nextFontManifest,
    supportsDynamicHTML,
    serverActions,
    buildId,
    appDirDevErrorLogger,
    assetPrefix = '',
    enableTainting,
  } = renderOpts

  // We need to expose the bundled `require` API globally for
  // react-server-dom-webpack. This is a hack until we find a better way.
  if (ComponentMod.__next_app__) {
    // @ts-ignore
    globalThis.__next_require__ = ComponentMod.__next_app__.require

    // @ts-ignore
    globalThis.__next_chunk_load__ = ComponentMod.__next_app__.loadChunk
  }

  const metadata: AppPageRenderResultMetadata = {}

  const appUsingSizeAdjustment = !!nextFontManifest?.appUsingSizeAdjust

  // TODO: fix this typescript
  const clientReferenceManifest = renderOpts.clientReferenceManifest!

  const workerName = 'app' + renderOpts.page
  const serverModuleMap: {
    [id: string]: {
      id: string
      chunks: string[]
      name: string
    }
  } = new Proxy(
    {},
    {
      get: (_, id: string) => {
        return {
          id: serverActionsManifest[
            process.env.NEXT_RUNTIME === 'edge' ? 'edge' : 'node'
          ][id].workers[workerName],
          name: id,
          chunks: [],
        }
      },
    }
  )

  setReferenceManifestsSingleton({
    clientReferenceManifest,
    serverActionsManifest,
    serverModuleMap,
  })

  const capturedErrors: Error[] = []
  const allCapturedErrors: Error[] = []
  const isNextExport = !!renderOpts.nextExport
  const { staticGenerationStore, requestStore } = baseCtx
  const { isStaticGeneration } = staticGenerationStore
  // when static generation fails during PPR, we log the errors separately. We intentionally
  // silence the error logger in this case to avoid double logging.
  const silenceStaticGenerationErrors =
    renderOpts.experimental.ppr && isStaticGeneration

  const serverComponentsErrorHandler = createErrorHandler({
    _source: 'serverComponentsRenderer',
    dev,
    isNextExport,
    errorLogger: appDirDevErrorLogger,
    capturedErrors,
    silenceLogger: silenceStaticGenerationErrors,
  })
  const flightDataRendererErrorHandler = createErrorHandler({
    _source: 'flightDataRenderer',
    dev,
    isNextExport,
    errorLogger: appDirDevErrorLogger,
    capturedErrors,
    silenceLogger: silenceStaticGenerationErrors,
  })
  const htmlRendererErrorHandler = createErrorHandler({
    _source: 'htmlRenderer',
    dev,
    isNextExport,
    errorLogger: appDirDevErrorLogger,
    capturedErrors,
    allCapturedErrors,
    silenceLogger: silenceStaticGenerationErrors,
  })

  ComponentMod.patchFetch()

  /**
   * Rules of Static & Dynamic HTML:
   *
   *    1.) We must generate static HTML unless the caller explicitly opts
   *        in to dynamic HTML support.
   *
   *    2.) If dynamic HTML support is requested, we must honor that request
   *        or throw an error. It is the sole responsibility of the caller to
   *        ensure they aren't e.g. requesting dynamic HTML for an AMP page.
   *
   * These rules help ensure that other existing features like request caching,
   * coalescing, and ISR continue working as intended.
   */
  const generateStaticHTML = supportsDynamicHTML !== true

  // Pull out the hooks/references from the component.
  const {
    createSearchParamsBailoutProxy,
    AppRouter,
    GlobalError,
    tree: loaderTree,
    taintObjectReference,
  } = ComponentMod

  if (enableTainting) {
    taintObjectReference(
      'Do not pass process.env to client components since it will leak sensitive data',
      process.env
    )
  }

  const { urlPathname } = staticGenerationStore

  staticGenerationStore.fetchMetrics = []
  metadata.fetchMetrics = staticGenerationStore.fetchMetrics

  // don't modify original query object
  query = { ...query }
  stripInternalQueries(query)

  const isRSCRequest = req.headers[RSC_HEADER.toLowerCase()] !== undefined

  const isPrefetchRSCRequest =
    isRSCRequest &&
    req.headers[NEXT_ROUTER_PREFETCH_HEADER.toLowerCase()] !== undefined

  /**
   * Router state provided from the client-side router. Used to handle rendering from the common layout down.
   */
  let providedFlightRouterState =
    isRSCRequest && (!isPrefetchRSCRequest || !renderOpts.experimental.ppr)
      ? parseAndValidateFlightRouterState(
          req.headers[NEXT_ROUTER_STATE_TREE.toLowerCase()]
        )
      : undefined

  /**
   * The metadata items array created in next-app-loader with all relevant information
   * that we need to resolve the final metadata.
   */
  let requestId: string

  if (process.env.NEXT_RUNTIME === 'edge') {
    requestId = crypto.randomUUID()
  } else {
    requestId = require('next/dist/compiled/nanoid').nanoid()
  }

  // During static generation we need to call the static generation bailout when reading searchParams
  const providedSearchParams = isStaticGeneration
    ? createSearchParamsBailoutProxy()
    : query

  const searchParamsProps = { searchParams: providedSearchParams }

  /**
   * Dynamic parameters. E.g. when you visit `/dashboard/vercel` which is rendered by `/dashboard/[slug]` the value will be {"slug": "vercel"}.
   */
  const params = renderOpts.params ?? {}

  const getDynamicParamFromSegment = makeGetDynamicParamFromSegment(
    params,
    providedFlightRouterState
  )

  const ctx: AppRenderContext = {
    ...baseCtx,
    getDynamicParamFromSegment,
    query,
    isPrefetch: isPrefetchRSCRequest,
    providedSearchParams,
    requestTimestamp,
    searchParamsProps,
    appUsingSizeAdjustment,
    providedFlightRouterState,
    requestId,
    defaultRevalidate: false,
    pagePath,
    clientReferenceManifest,
    assetPrefix,
    flightDataRendererErrorHandler,
    serverComponentsErrorHandler,
    isNotFoundPath,
    res,
  }

  if (isRSCRequest && !isStaticGeneration) {
    return generateFlight(ctx)
  }

  const hasPostponed = typeof renderOpts.postponed === 'string'

  // Create the resolver that can get the flight payload when it's ready or
  // throw the error if it occurred. If we are not generating static HTML, we
  // don't need to generate the flight payload because it's a dynamic request
  // which means we're either getting the flight payload only or just the
  // regular HTML.
  const flightDataResolver = isStaticGeneration
    ? createFlightDataResolver(ctx)
    : null

  // Get the nonce from the incoming request if it has one.
  const csp =
    req.headers['content-security-policy'] ||
    req.headers['content-security-policy-report-only']
  let nonce: string | undefined
  if (csp && typeof csp === 'string') {
    nonce = getScriptNonceFromHeader(csp)
  }

  const serverComponentsRenderOpts: ServerComponentRendererOptions = {
    inlinedDataTransformStream: new TransformStream<Uint8Array, Uint8Array>(),
    clientReferenceManifest,
    formState: null,
    ComponentMod,
    serverComponentsErrorHandler,
    nonce,
  }

  const validateRootLayout = dev
    ? {
        assetPrefix: renderOpts.assetPrefix,
        getTree: () =>
          createFlightRouterStateFromLoaderTree(
            loaderTree,
            getDynamicParamFromSegment,
            query
          ),
      }
    : undefined

  const { HeadManagerContext } =
    require('../../shared/lib/head-manager-context.shared-runtime') as typeof import('../../shared/lib/head-manager-context.shared-runtime')

  // On each render, create a new `ServerInsertedHTML` context to capture
  // injected nodes from user code (`useServerInsertedHTML`).
  const { ServerInsertedHTMLProvider, renderServerInsertedHTML } =
    createServerInsertedHTML()

  getTracer().getRootSpanAttributes()?.set('next.route', pagePath)

  // Create a promise that will help us signal when the headers have been
  // written to the metadata for static generation as they aren't written to the
  // response directly.
  const onHeadersFinished = new DetachedPromise<void>()

  const renderToStream = getTracer().wrap(
    AppRenderSpan.getBodyResult,
    {
      spanName: `render route (app) ${pagePath}`,
      attributes: {
        'next.route': pagePath,
      },
    },
    async ({
      asNotFound,
      tree,
      formState,
    }: {
      /**
       * This option is used to indicate that the page should be rendered as
       * if it was not found. When it's enabled, instead of rendering the
       * page component, it renders the not-found segment.
       *
       */
      asNotFound: boolean
      tree: LoaderTree
      formState: any
    }) => {
      const polyfills: JSX.IntrinsicElements['script'][] =
        buildManifest.polyfillFiles
          .filter(
            (polyfill) =>
              polyfill.endsWith('.js') && !polyfill.endsWith('.module.js')
          )
          .map((polyfill) => ({
            src: `${assetPrefix}/_next/${polyfill}${getAssetQueryString(
              ctx,
              false
            )}`,
            integrity: subresourceIntegrityManifest?.[polyfill],
            crossOrigin: renderOpts.crossOrigin,
            noModule: true,
            nonce,
          }))

      const [preinitScripts, bootstrapScript] = getRequiredScripts(
        buildManifest,
        assetPrefix,
        renderOpts.crossOrigin,
        subresourceIntegrityManifest,
        getAssetQueryString(ctx, true),
        nonce
      )

      const ServerComponentsRenderer = createServerComponentsRenderer(tree, {
        ctx,
        preinitScripts,
        options: serverComponentsRenderOpts,
      })

      const children = (
        <HeadManagerContext.Provider
          value={{
            appDir: true,
            nonce,
          }}
        >
          <ServerInsertedHTMLProvider>
            <ServerComponentsRenderer asNotFound={asNotFound} />
          </ServerInsertedHTMLProvider>
        </HeadManagerContext.Provider>
      )

      const getServerInsertedHTML = makeGetServerInsertedHTML({
        polyfills,
        renderServerInsertedHTML,
        hasPostponed,
      })

      const renderer = createStaticRenderer({
        ppr: renderOpts.experimental.ppr,
        isStaticGeneration,
        // If provided, the postpone state should be parsed as JSON so it can be
        // provided to React.
        postponed: renderOpts.postponed
          ? JSON.parse(renderOpts.postponed)
          : null,
        streamOptions: {
          onError: htmlRendererErrorHandler,
          onHeaders: (headers: Headers) => {
            // If this is during static generation, we shouldn't write to the
            // headers object directly, instead we should add to the render
            // result.
            if (isStaticGeneration) {
              headers.forEach((value, key) => {
                metadata.headers ??= {}
                metadata.headers[key] = value
              })

              // Resolve the promise to continue the stream.
              onHeadersFinished.resolve()
            } else {
              headers.forEach((value, key) => {
                res.appendHeader(key, value)
              })
            }
          },
          maxHeadersLength: 600,
          nonce,
          bootstrapScripts: [bootstrapScript],
          formState,
        },
      })

      try {
        let { stream, postponed } = await renderer.render(children)

        // If the stream was postponed, we need to add the result to the
        // metadata so that it can be resumed later.
        if (postponed) {
          metadata.postponed = JSON.stringify(postponed)

          // We don't need to "continue" this stream now as it's continued when
          // we resume the stream.
          return stream
        }

        const options: ContinueStreamOptions = {
          inlinedDataStream:
            serverComponentsRenderOpts.inlinedDataTransformStream.readable,
          isStaticGeneration: isStaticGeneration || generateStaticHTML,
          getServerInsertedHTML: () => getServerInsertedHTML(allCapturedErrors),
          serverInsertedHTMLToHead: !renderOpts.postponed,
          // If this render generated a postponed state or this is a resume
          // render, we don't want to validate the root layout as it's already
          // partially rendered.
          validateRootLayout:
            !postponed && !renderOpts.postponed
              ? validateRootLayout
              : undefined,
          // App Render doesn't need to inject any additional suffixes.
          suffix: undefined,
        }

        if (renderOpts.postponed) {
          return await continuePostponedFizzStream(stream, options)
        }

        return await continueFizzStream(stream, options)
      } catch (err: any) {
        if (
          err.code === 'NEXT_STATIC_GEN_BAILOUT' ||
          err.message?.includes(
            'https://nextjs.org/docs/advanced-features/static-html-export'
          )
        ) {
          // Ensure that "next dev" prints the red error overlay
          throw err
        }

        if (isStaticGeneration && err.digest === DYNAMIC_ERROR_CODE) {
          // ensure that DynamicUsageErrors bubble up during static generation
          // as this will indicate that the page needs to be dynamically rendered
          throw err
        }

        if (err.digest === NEXT_DYNAMIC_NO_SSR_CODE) {
          warn(
            `Entire page ${pagePath} deopted into client-side rendering. https://nextjs.org/docs/messages/deopted-into-client-rendering`,
            pagePath
          )
        }

        if (isNotFoundError(err)) {
          res.statusCode = 404
        }
        let hasRedirectError = false
        if (isRedirectError(err)) {
          hasRedirectError = true
          res.statusCode = getRedirectStatusCodeFromError(err)
          if (err.mutableCookies) {
            const headers = new Headers()

            // If there were mutable cookies set, we need to set them on the
            // response.
            if (appendMutableCookies(headers, err.mutableCookies)) {
              res.setHeader('set-cookie', Array.from(headers.values()))
            }
          }
          const redirectUrl = addPathPrefix(
            getURLFromRedirectError(err),
            renderOpts.basePath
          )
          res.setHeader('Location', redirectUrl)
        }

        const is404 = res.statusCode === 404
        if (!is404 && !hasRedirectError) {
          res.statusCode = 500
        }

        // Preserve the existing RSC inline chunks from the page rendering.
        // To avoid the same stream being operated twice, clone the origin stream for error rendering.
        const serverErrorComponentsRenderOpts: typeof serverComponentsRenderOpts =
          {
            ...serverComponentsRenderOpts,
            inlinedDataTransformStream: cloneTransformStream(
              serverComponentsRenderOpts.inlinedDataTransformStream
            ),
            formState,
          }

        const errorType = is404
          ? 'not-found'
          : hasRedirectError
          ? 'redirect'
          : undefined

        const errorMeta = (
          <>
            {res.statusCode >= 400 && <meta name="robots" content="noindex" />}
            {process.env.NODE_ENV === 'development' && (
              <meta name="next-error" content="not-found" />
            )}
          </>
        )

        const [errorPreinitScripts, errorBootstrapScript] = getRequiredScripts(
          buildManifest,
          assetPrefix,
          renderOpts.crossOrigin,
          subresourceIntegrityManifest,
          getAssetQueryString(ctx, false),
          nonce
        )

        const ErrorPage = createServerComponentRenderer(
          async () => {
            errorPreinitScripts()
            const [MetadataTree] = createMetadataComponents({
              tree,
              pathname: urlPathname,
              errorType,
              searchParams: providedSearchParams,
              getDynamicParamFromSegment,
              appUsingSizeAdjustment,
            })

            const head = (
              <>
                {/* Adding requestId as react key to make metadata remount for each render */}
                <MetadataTree key={requestId} />
                {errorMeta}
              </>
            )

            const initialTree = createFlightRouterStateFromLoaderTree(
              tree,
              getDynamicParamFromSegment,
              query
            )

            // For metadata notFound error there's no global not found boundary on top
            // so we create a not found page with AppRouter
            const initialSeedData: CacheNodeSeedData = [
              initialTree[0],
              null,
              <html id="__next_error__">
                <head></head>
                <body></body>
              </html>,
            ]
            return (
              <AppRouter
                buildId={buildId}
                assetPrefix={assetPrefix}
                initialCanonicalUrl={urlPathname}
                initialTree={initialTree}
                initialHead={head}
                globalErrorComponent={GlobalError}
                initialSeedData={initialSeedData}
              />
            )
          },
          {
            ...serverErrorComponentsRenderOpts,
            ComponentMod,
            serverComponentsErrorHandler,
            nonce,
          }
        )

        try {
          const fizzStream = await renderToInitialFizzStream({
            ReactDOMServer: require('react-dom/server.edge'),
            element: <ErrorPage />,
            streamOptions: {
              nonce,
              // Include hydration scripts in the HTML
              bootstrapScripts: [errorBootstrapScript],
              formState,
            },
          })

          return await continueFizzStream(fizzStream, {
            inlinedDataStream:
              serverErrorComponentsRenderOpts.inlinedDataTransformStream
                .readable,
            isStaticGeneration,
            getServerInsertedHTML: () => getServerInsertedHTML([]),
            serverInsertedHTMLToHead: true,
            validateRootLayout,
            suffix: undefined,
          })
        } catch (finalErr: any) {
          if (
            process.env.NODE_ENV === 'development' &&
            isNotFoundError(finalErr)
          ) {
            const bailOnNotFound: typeof import('../../client/components/dev-root-not-found-boundary').bailOnNotFound =
              require('../../client/components/dev-root-not-found-boundary').bailOnNotFound
            bailOnNotFound()
          }
          throw finalErr
        }
      }
    }
  )

  // For action requests, we handle them differently with a special render result.
  const actionRequestResult = await handleAction({
    req,
    res,
    ComponentMod,
    serverModuleMap,
    generateFlight,
    staticGenerationStore,
    requestStore,
    serverActions,
    ctx,
  })

  let formState: null | any = null
  if (actionRequestResult) {
    if (actionRequestResult.type === 'not-found') {
      const notFoundLoaderTree = createNotFoundLoaderTree(loaderTree)
      return new RenderResult(
        await renderToStream({
          asNotFound: true,
          tree: notFoundLoaderTree,
          formState,
        }),
        { metadata }
      )
    } else if (actionRequestResult.type === 'done') {
      if (actionRequestResult.result) {
        actionRequestResult.result.assignMetadata(metadata)
        return actionRequestResult.result
      } else if (actionRequestResult.formState) {
        formState = actionRequestResult.formState
      }
    }
  }

  const options: RenderResultOptions = {
    metadata,
  }

  let response: RenderResultResponse = await renderToStream({
    asNotFound: isNotFoundPath,
    tree: loaderTree,
    formState,
  })

  // If we have pending revalidates, wait until they are all resolved.
  if (staticGenerationStore.pendingRevalidates) {
    options.waitUntil = Promise.all(
      Object.values(staticGenerationStore.pendingRevalidates)
    )
  }

  addImplicitTags(staticGenerationStore)

  if (staticGenerationStore.tags) {
    metadata.fetchTags = staticGenerationStore.tags.join(',')
  }

  // Create the new render result for the response.
  const result = new RenderResult(response, options)

  // If we aren't performing static generation, we can return the result now.
  if (!isStaticGeneration) {
    return result
  }

  // If this is static generation, we should read this in now rather than
  // sending it back to be sent to the client.
  response = await result.toUnchunkedString(true)

  // Timeout after 1.5 seconds for the headers to write. If it takes
  // longer than this it's more likely that the stream has stalled and
  // there is a React bug. The headers will then be updated in the render
  // result below when the metadata is re-added to the new render result.
  const onTimeout = new DetachedPromise<never>()
  const timeout = setTimeout(() => {
    onTimeout.reject(
      new Error(
        'Timeout waiting for headers to be emitted, this is a bug in Next.js'
      )
    )
  }, 1500)

  // Race against the timeout and the headers being written.
  await Promise.race([onHeadersFinished.promise, onTimeout.promise])

  // It got here, which means it did not reject, so clear the timeout to avoid
  // it from rejecting again (which is a no-op anyways).
  clearTimeout(timeout)

  if (
    // if PPR is enabled
    renderOpts.experimental.ppr &&
    // and a call to `postpone` happened
    staticGenerationStore.postponeWasTriggered &&
    // but there's no postpone state
    !metadata.postponed
  ) {
    // a call to postpone was made but was caught and not detected by Next.js. We should fail the build immediately
    // as we won't be able to generate the static part
    warn('')
    error(
      `Prerendering ${urlPathname} needs to partially bail out because something dynamic was used. ` +
        `React throws a special object to indicate where we need to bail out but it was caught ` +
        `by a try/catch or a Promise was not awaited. These special objects should not be caught ` +
        `by your own try/catch. Learn more: https://nextjs.org/docs/messages/ppr-caught-error`
    )

    if (capturedErrors.length > 0) {
      warn(
        'The following error was thrown during build, and may help identify the source of the issue:'
      )

      error(capturedErrors[0])
    }

    throw new MissingPostponeDataError(
      `An unexpected error occurred while prerendering ${urlPathname}. Please check the logs above for more details.`
    )
  }

  if (!flightDataResolver) {
    throw new Error(
      'Invariant: Flight data resolver is missing when generating static HTML'
    )
  }

  // If we encountered any unexpected errors during build we fail the
  // prerendering phase and the build.
  if (capturedErrors.length > 0) {
    throw capturedErrors[0]
  }

  // Wait for and collect the flight payload data if we don't have it
  // already
  const flightData = await flightDataResolver()
  if (flightData) {
    metadata.flightData = flightData
  }

  // If force static is specifically set to false, we should not revalidate
  // the page.
  if (staticGenerationStore.forceStatic === false) {
    staticGenerationStore.revalidate = 0
  }

  // Copy the revalidation value onto the render result metadata.
  metadata.revalidate =
    staticGenerationStore.revalidate ?? ctx.defaultRevalidate

  // provide bailout info for debugging
  if (metadata.revalidate === 0) {
    metadata.staticBailoutInfo = {
      description: staticGenerationStore.dynamicUsageDescription,
      stack: staticGenerationStore.dynamicUsageStack,
    }
  }

  return new RenderResult(response, options)
}

export type AppPageRender = (
  req: IncomingMessage,
  res: ServerResponse,
  pagePath: string,
  query: NextParsedUrlQuery,
  renderOpts: RenderOpts
) => Promise<RenderResult<AppPageRenderResultMetadata>>

export const renderToHTMLOrFlight: AppPageRender = (
  req,
  res,
  pagePath,
  query,
  renderOpts
) => {
  // TODO: this includes query string, should it?
  const pathname = validateURL(req.url)

  return RequestAsyncStorageWrapper.wrap(
    renderOpts.ComponentMod.requestAsyncStorage,
    { req, res, renderOpts },
    (requestStore) =>
      StaticGenerationAsyncStorageWrapper.wrap(
        renderOpts.ComponentMod.staticGenerationAsyncStorage,
        {
          urlPathname: pathname,
          renderOpts,
          postpone: React.unstable_postpone,
        },
        (staticGenerationStore) =>
          renderToHTMLOrFlightImpl(req, res, pagePath, query, renderOpts, {
            requestStore,
            staticGenerationStore,
            componentMod: renderOpts.ComponentMod,
            renderOpts,
          })
      )
  )
}
