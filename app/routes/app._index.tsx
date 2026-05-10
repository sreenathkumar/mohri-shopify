import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "app/db.server";
import { disconnectStore, getRedirectUrl, registerShopWebhooks } from "app/services/app.server";
import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { FetcherResponse, RedirectResponse } from "types/connectionType";
import { authenticate } from "../shopify.server";

//loader function
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  //get shop url from session and check if it exists in the database
  const shopDomain = session.shop;

  //check if the shop is connected by looking it up in the database
  const res = await prisma.shops.findFirst({
    where: {
      domain: shopDomain,
    },
  });

  return {
    dashboardUrl: process.env.DASHBOARD_URL,
    isConnected: !!res,
    shop: res?.domain || null
  }
};

//action function 
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const { intent, } = await request.json();

  switch (intent) {
    case 'get_redirect_url': {
      const redirectRes = await getRedirectUrl({ session });
      return redirectRes;
    }
    case 'register_webhook': {
      const webhookRes = await registerShopWebhooks({ session });
      return webhookRes;
    }
    case 'disconnect_store': {
      const disconnectRes = await disconnectStore({ admin, session });
      return disconnectRes;
    }

    default:
      return {
        ok: false,
        errors: [{
          message: "Invalid intent",
        }]
      }
  }

};

export default function Index() {
  const shopify = useAppBridge();
  const { isConnected, shop, dashboardUrl } = useLoaderData();
  const [shopConnected, setShopConnected] = useState(isConnected);

  const redirectUrlFetcher = useFetcher<RedirectResponse>(); // handle connect/disconnect store action
  const webhookFetcher = useFetcher<FetcherResponse>(); // handle register webhooks action after successful connection
  const disconnectFetcher = useFetcher<FetcherResponse>(); // handle disconnect store action

  const redirectUrlLoading =
    ["loading"].includes(redirectUrlFetcher.state) &&
    redirectUrlFetcher.formMethod === "POST";

  const disconnectionLoading = ["loading"].includes(disconnectFetcher.state) && disconnectFetcher.formMethod === "POST";

  // Ref to store the popup window instance
  const popupRef = useRef<Window | null>(null);


  // Handle connect button click
  const handleConnect = () => {
    sessionStorage.setItem('browser_secret', crypto.randomUUID()); // set the browser secret to validate the connection in the popup later

    const popup = open('about:blank', '_blank', "width=500,height=600");
    popup?.document.write(`
  <html>
    <head><title>Loading...</title></head>
    <body style="display: flex; align-items: center; justify-content: center; height: 100%;">
      <p>Loading, please wait...</p>
    </body>
  </html>
`);
    popupRef.current = popup;

    redirectUrlFetcher.submit({ intent: 'get_redirect_url' }, { method: "POST", encType: "application/json" });
  };

  // Handle disconnect button click
  const handleDisconnect = () => {
    disconnectFetcher.submit({ intent: 'disconnect_store' }, { method: "POST", encType: "application/json" });
  }

  // get the redirect url from the backend and handle the message from popup
  useEffect(() => {
    console.log("Fetch result:", redirectUrlFetcher.data);
    // Only run when request is done and we have data
    if (redirectUrlFetcher.state !== "idle" || !redirectUrlFetcher.data) return;

    const { ok, errors } = redirectUrlFetcher.data;


    if (!ok || errors) {
      errors.forEach((error) => shopify.toast.show(error?.message, { isError: true }));
    }

    //update the popup url when backend send the redirect url in response
    if (ok) {
      const { redirectUrl } = redirectUrlFetcher.data;

      const url = new URL(redirectUrl);
      url.searchParams.set("state", 'browser_secret');

      popupRef.current?.location.assign(url.toString());
    }

    //function which handle the message from popup
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== popupRef.current || event.origin !== 'https://piximento.pixelatedcode.com') return; // Ensure message is from trusted origin

      //check if the state is valid or not
      if (event.data.type === 'CONFIRM_STATE') {
        console.log('state from popup', event.data.state)
        // If the state matches, it means the connection was successful
        const isExists = sessionStorage.getItem(event.data.state);
        sessionStorage.removeItem(event.data.state); // Remove the state from session storage for security

        if (isExists) {
          popupRef.current?.postMessage({ type: 'STATE_CONFIRMED' }, 'https://piximento.pixelatedcode.com');
        } else {
          shopify.toast.show("Connection is compromized", { isError: true });

        }
      }

      //when connection is successful register webhook and show success message
      if (event.data.type === 'CONNECTION_SUCCEDED') {
        //register webhooks after successful connection
        webhookFetcher.submit({ intent: 'register_webhook' }, { method: "POST", encType: "application/json" });
      }
    };

    window.addEventListener('message', handleMessage);

    // Cleanup the event listener when component unmounts or when connectionFetcher changes
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [redirectUrlFetcher.data, redirectUrlFetcher.state]);


  // handle the response from register webhook action and show appropriate message
  useEffect(() => {
    if (webhookFetcher.state !== "idle" || !webhookFetcher.data) return;

    const { ok, errors } = webhookFetcher.data;

    if (!ok || errors) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      errors.forEach((error: any) => shopify.toast.show(error?.message, { isError: true }));
      popupRef.current?.close();
      return;
    }

    // If webhooks registered successfully, show success message and update the state
    shopify.toast.show("Store connected successfully");
    setShopConnected(true);
    popupRef.current?.close();
  }, [webhookFetcher.data, webhookFetcher.state]);

  // handle the response from disconnect store action and show appropriate message
  useEffect(() => {
    if (disconnectFetcher.state !== "idle" || !disconnectFetcher.data) return;

    const { ok, errors } = disconnectFetcher.data;

    if (!ok || errors) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      errors.forEach((error: any) => shopify.toast.show(error?.message, { isError: true }));
      return;
    }

    // If disconnected successfully, show success message and update the state
    shopify.toast.show("Store disconnected successfully");
    setShopConnected(false);
  }, [disconnectFetcher.data, disconnectFetcher.state]);

  return (
    <s-page heading="Connect your store">
      {
        shopConnected && (
          <s-button slot="primary-action" variant="primary" onClick={handleDisconnect} {...(disconnectionLoading ? { loading: true } : {})}>
            {`Disconnect store`}
          </s-button>
        )
      }

      <s-section heading={`Congrats on installing Pixi Mento. 🎉`}>
        <s-paragraph>
          This app connects your store to the Pixi Mento dashboard. It securely reads your order, product, and customer data so you can manage deliveries and cash collection in one place. You can uninstall anytime to revoke access.
        </s-paragraph>

        {!shopConnected && <s-button onClick={handleConnect} {...(redirectUrlLoading ? { loading: true } : {})}>
          {`Connect store`}
        </s-button>}

      </s-section>

      <s-section slot="aside" heading="Connection health">
        <s-stack gap="base">
          <s-stack direction="inline" gap="base">
            <s-text type="strong">Status: </s-text>
            <s-badge tone={shopConnected ? "success" : "critical"}>
              {shopConnected ? "Connected" : "Disconnected"}
            </s-badge>
          </s-stack>
          {
            shopConnected && (<>
              <s-stack direction="inline" gap="small">
                <s-text type="strong">Shop: </s-text>
                <s-text>{shop}</s-text>
              </s-stack>
              <s-stack direction="inline" gap="small">
                <s-text type="strong">Data access: </s-text>
                <s-chip>read_products</s-chip><s-chip>read_orders</s-chip><s-chip>read_customers</s-chip>
              </s-stack>
            </>
            )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Next steps">
        <s-unordered-list>
          <s-list-item>
            <s-stack direction="inline" gap="small">
              <s-text>Visit our{" "}</s-text>
              <s-stack direction="inline">
                <s-link
                  href={`${dashboardUrl}/dashboard`}
                  target="_blank"
                >
                  dashboard
                </s-link>
                <s-icon type="external" />
              </s-stack>

            </s-stack>
          </s-list-item>
          <s-list-item>
            <s-stack direction="inline" gap="small">
              <s-text>Contact our{" "}</s-text>
              <s-stack direction="inline">
                <s-link
                  href={`${dashboardUrl}/help`}
                  target="_blank"
                >
                  support team
                </s-link>
                <s-icon type="external" />
              </s-stack>

            </s-stack>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
