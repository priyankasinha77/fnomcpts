import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { makeApiCall } from './api.js';
import { EntityManager } from './entityManager.js';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';

const entityManager = new EntityManager();
// PAGINATION: Define a default page size to prevent oversized payloads.
const DEFAULT_PAGE_SIZE = 5;

// Helper function to safely send notifications
async function safeNotification(context: RequestHandlerExtra<ServerRequest, ServerNotification>, notification: any): Promise<void> {
    try {
        await context.sendNotification(notification);
    } catch (error) {
        console.log('Notification failed (this is normal in test environments):', error);
    }
}

// Helper function to build the OData $filter string from an object
function buildFilterString(filterObject?: Record<string, string>): string | null {
    if (!filterObject || Object.keys(filterObject).length === 0) {
        return null;
    }
    const filterClauses = Object.entries(filterObject).map(([key, value]) => {
        return `${key} eq '${value}'`;
    });
    return filterClauses.join(' and ');
}


// --- Zod Schemas for Tool Arguments ---

const odataQuerySchema = z.object({
    entity: z.string().describe("The OData entity set to query (e.g., CustomersV3, ReleasedProductsV2)."),
    select: z.string().optional().describe("OData $select query parameter to limit the fields returned."),
    filter: z.record(z.string()).optional().describe("Key-value pairs for filtering. e.g., { ProductNumber: 'D0001', dataAreaId: 'usmf' }."),
    expand: z.string().optional().describe("OData $expand query parameter."),
    // PAGINATION: Updated description for 'top' to explain its role in pagination.
    top: z.number().optional().describe(`The number of records to return per page. Defaults to ${DEFAULT_PAGE_SIZE}.`),
    // PAGINATION: Added 'skip' parameter for fetching subsequent pages.
    skip: z.number().optional().describe("The number of records to skip. Used for pagination to get the next set of results."),
    crossCompany: z.boolean().optional().describe("Set to true to query across all companies."),
});



/**
 * Creates and configures the MCP server with all the tools for the D365 API.
 * @returns {McpServer} The configured McpServer instance. 
 */
export const getServer = (): McpServer => {
    const server = new McpServer({
        name: 'd365-fno-mcp-server',
        version: '1.0.0',
    });

    // --- Tool Definitions ---

    server.tool(
        'odataQuery',
        'Executes a generic GET request against a Dynamics 365 OData entity. The entity name does not need to be case-perfect. Responses are paginated.',
        odataQuerySchema.shape,
        async (args: z.infer<typeof odataQuerySchema>, context: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
            
            const correctedEntity = await entityManager.findBestMatch(args.entity);
    
            if (!correctedEntity) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Could not find a matching entity for '${args.entity}'. Please provide a more specific name.` }]
                };
            }
            
            const effectiveArgs = { ...args };

            if (effectiveArgs.filter?.dataAreaId && effectiveArgs.crossCompany !== false) {
                if (!effectiveArgs.crossCompany) {
                    await safeNotification(context, {
                        method: "notifications/message",
                        params: { level: "info", data: `Filter on company ('dataAreaId') detected. Automatically enabling cross-company search.` }
                    });
                }
                effectiveArgs.crossCompany = true;
            }

            await safeNotification(context, {
                method: "notifications/message",
                params: { level: "info", data: `Corrected entity name from '${args.entity}' to '${correctedEntity}'.` }
            });
            
            const { entity, ...queryParams } = effectiveArgs;
            const filterString = buildFilterString(queryParams.filter);
            const url = new URL(`${process.env.DYNAMICS_RESOURCE_URL}/data/${correctedEntity}`);

            // PAGINATION: Apply query parameters including the new skip and a default top.
            const topValue = queryParams.top || DEFAULT_PAGE_SIZE;
            url.searchParams.append('$top', topValue.toString());

            if (queryParams.skip) {
                url.searchParams.append('$skip', queryParams.skip.toString());
            }

            if (queryParams.crossCompany) url.searchParams.append('cross-company', 'true');
            if (queryParams.select) url.searchParams.append('$select', queryParams.select);
            if (filterString) url.searchParams.append('$filter', filterString);
            if (queryParams.expand) url.searchParams.append('$expand', queryParams.expand);
            
            return makeApiCall('GET', url.toString(), null, async (notification) => {
                await safeNotification(context, notification);
            });
        }
    );

 
    return server;
};

