import { AdminApiContext, Session } from "@shopify/shopify-app-react-router/server";
import prisma from "app/db.server";
import { registerWebhooks } from "app/shopify.server";
import * as jose from "jose";
import { FetcherResponse, RedirectResponse } from "types/connectionType";

export async function registerShopWebhooks({ session }: { session: Session }): Promise<FetcherResponse> {
    try {
        // Register webhooks
        const webhookRegistrationResult = await registerWebhooks({ session });

        if (!webhookRegistrationResult) {
            return {
                ok: false,
                message: "An error occurred while connecting the store",
                errors: [{
                    message: "Failed to register webhooks",
                }],
            }
        }

        // check if any specific webhook registration failed and return an error
        for (const [topic, registrations] of Object.entries(webhookRegistrationResult)) {
            for (const registration of registrations) {
                if (!registration.success) {
                    console.error(`Failed to register webhook for topic ${topic}:`, registration.result);
                    return {
                        ok: false,
                        message: 'An error occurred while connecting the store',
                        errors: [{
                            message: `Failed to register webhook for topic ${topic}: ${registration.result}`,
                        }],
                    }
                }
            }
        }

        return {
            ok: true,
            message: "Store connected successfully",
        }

    } catch (error) {
        return {
            ok: false,
            message: 'An error occurred while connecting the store',
            errors: [{
                message: error instanceof Error ? error.message : "An unknown error occurred",
            }],
        }
    }

}

export async function disconnectStore({ admin, session }: { admin: AdminApiContext, session: Session }): Promise<FetcherResponse> {
    try {
        const webhookQuery = await admin.graphql(
            `query {
            webhookSubscriptions(first: 10) {
                edges {
                    node {
                        id
                        topic
                    }
                }
            }
        }`
        );
        const webhookQueryRes = await webhookQuery.json();

        // Delete all registered webhooks
        const webhooks = webhookQueryRes.data.webhookSubscriptions.edges;

        for (const webhook of webhooks) {
            const webhookId = webhook.node.id;
            const deleteResult = await admin.graphql(
                `mutation {
                webhookSubscriptionDelete(id: "${webhookId}") {
                    deletedWebhookSubscriptionId
                    userErrors {
                        field
                        message
                    }
                }
            }`
            );
            const deleteRes = await deleteResult.json();

            if (deleteRes.data.webhookSubscriptionDelete.userErrors.length > 0) {
                console.error(`Failed to delete webhook ${webhookId}:`, deleteRes.data.webhookSubscriptionDelete.userErrors);
                return {
                    ok: false,
                    message: 'An error occurred while disconnecting the store',
                    errors: [{
                        message: `Failed to delete webhook ${webhookId}: ${deleteRes.data.webhookSubscriptionDelete.userErrors.map((err: { field: string, message: 'string' }) => err.message).join(", ")}`,
                    }],
                }
            }
        }

        // Remove the shop from the database
        await prisma.shops.deleteMany({
            where: {
                domain: session.shop,
            }
        });

        return {
            ok: true,
            message: "Store disconnected successfully",
        }

    } catch (error) {
        return {
            ok: false,
            message: 'An error occurred while disconnecting the store',
            errors: [{
                message: error instanceof Error ? error.message : "An unknown error occurred",
            }],
        }
    }
}

export async function getRedirectUrl({ session }: { session: Session }): Promise<RedirectResponse> {
    try {
        const apiSecret = process.env.SHOPIFY_API_SECRET;
        const dashboardUrl = process.env.DASHBOARD_URL;

        if (!apiSecret) {
            throw new Error('SHOPIFY_API_SECRET is not set');
        }

        if (!dashboardUrl) {
            throw new Error('DASHBOARD_URL is not set');
        }

        const secret = new TextEncoder().encode(apiSecret);

        const token = await new jose.SignJWT({
            domain: session.shop,
            platform: 'shopify',
            sessionId: session.id,
        })
            .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
            .setIssuedAt()
            .setIssuer('your-app-backend')
            .setAudience('your-dashboard-service')
            .setExpirationTime('5m')
            .sign(secret);

        const url = new URL('/stores', dashboardUrl);
        url.searchParams.set('token', token);

        return {
            ok: true,
            message: "Redirect URL generated successfully",
            redirectUrl: url.toString(),
        };
    } catch (error) {
        console.error('Error generating JWT token:', error);
        return {
            ok: false,
            message: 'An error occurred while generating the redirect URL',
            errors: [
                {
                    message:
                        error instanceof Error
                            ? error.message
                            : 'An unknown error occurred',
                },
            ],
        };
    }
}