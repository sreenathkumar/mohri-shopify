export type FetcherResponse<
    ExtraSuccess = unknown,
    ExtraError = unknown
> = | ({
    ok: true;
    message: string;
    errors?: undefined;
} & ExtraSuccess)
    | ({
        ok: false;
        message: string;
        errors: [{
            message: string;
        }]
    } & ExtraError);

export type RedirectResponse = FetcherResponse<{
    redirectUrl: string;
}>;