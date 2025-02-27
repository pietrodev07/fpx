import { useToast } from "@/components/ui/use-toast";
import { useAiEnabled } from "@/hooks/useAiEnabled";
import { errorHasMessage, isJson } from "@/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { createFormDataParameter } from "../FormDataForm/data";
import {
  type KeyValueParameter,
  createKeyValueParameters,
} from "../KeyValueForm";
import type { ProbedRoute, Requestornator } from "../queries";
import type { RequestorBody } from "../reducer";
import { isRequestorBodyType } from "../reducer/request-body";
import { useAiRequestData } from "./generate-request-data";

export const FRIENDLY = "Friendly" as const;
export const HOSTILE = "QA" as const;

export type AiTestingPersona = "Friendly" | "QA";

type FormSetters = {
  setBody: (body: string | RequestorBody) => void;
  setQueryParams: (params: KeyValueParameter[]) => void;
  setRequestHeaders: (params: KeyValueParameter[]) => void;
  setPath: (path: string) => void;
  updatePathParamValues: (pathParams: { key: string; value: string }[]) => void;
  addServiceUrlIfBarePath: (path: string) => string;
};

export function useAi(
  selectedRoute: ProbedRoute | null,
  matchingMiddleware: ProbedRoute[] | null,
  requestHistory: Array<Requestornator>,
  formSetters: FormSetters,
  body: RequestorBody,
) {
  const { toast } = useToast();
  const isAiEnabled = useAiEnabled();

  const { ignoreAiInputsBanner, setIgnoreAiInputsBanner } =
    useIgnoreAiGeneratedInputsBanner();

  const [showAiGeneratedInputsBanner, setShowAiGeneratedInputsBanner] =
    useState(false);

  const {
    setBody,
    setQueryParams,
    setPath,
    setRequestHeaders,
    updatePathParamValues,
    addServiceUrlIfBarePath,
  } = formSetters;

  const bodyType = body.type;

  // Testing persona determines what kind of request data will get generated by the AI
  const [testingPersona, setTestingPersona] =
    useState<AiTestingPersona>(FRIENDLY);

  // We will send the recent history as context
  const recentHistory = useMemo(() => {
    return requestHistory.slice(0, 5);
  }, [requestHistory]);

  const { isFetching: isLoadingParameters, refetch: generateRequestData } =
    useAiRequestData(
      selectedRoute,
      matchingMiddleware,
      bodyType,
      recentHistory,
      testingPersona,
    );

  const fillInRequest = useCallback(() => {
    generateRequestData().then(({ data, isError, error }) => {
      if (isError) {
        toast({
          variant: "destructive",
          title: "Uh oh! Failed to generate request data",
          description: errorHasMessage(error)
            ? error?.message
            : "There was a problem with your request.",
          // action: <ToastAction altText="Try again"> Try again</ ToastAction >,
        });
        return;
      }

      const body = data.request?.body;
      const aiBodyType = data.request?.bodyType;
      const queryParams = data.request?.queryParams;
      const path = data.request?.path;
      const pathParams = data.request?.pathParams;
      const headers = data.request?.headers;

      if (body || typeof body === "string") {
        const nextBodyType = isRequestorBodyType(aiBodyType?.type)
          ? aiBodyType?.type
          : ("json" as const);

        let nextBody: RequestorBody = {
          type: nextBodyType,
          value: "",
        };

        if (aiBodyType?.type === "form-data") {
          if (aiBodyType?.isMultipart) {
            nextBody = {
              type: "form-data" as const,
              isMultipart: true,
              // TODO - Parse the form data, but also handle file placeholders from the AI
              value: tryParseFormData(body) ?? [],
            };
          } else {
            nextBody = {
              type: "form-data" as const,
              isMultipart: false,
              value: tryParseFormData(body) ?? [],
            };
          }
        }

        if (aiBodyType?.type === "file") {
          nextBody = {
            type: "file" as const,
            // HACK - Clear the body for files, maybe add a random file later?
            value: undefined,
          };
        }

        if (nextBody.type === "json") {
          const prettyBody = tryPrettify(body);
          if (isJson(prettyBody)) {
            nextBody.value = prettyBody;
          } else if (typeof body === "string") {
            // NOTE - The AI might deliberately be setting the wrong content type...
            //        So we do not fall back to type: text
            nextBody.value = body;
          }
        }

        setBody(nextBody);
      }

      // NOTE - We need to be clear on the types here, otherwise this could wreak havoc on our form data
      if (validateKeyValueParamsFromResponse(queryParams)) {
        const newParameters = createKeyValueParameters(queryParams);
        setQueryParams(newParameters);
      } else {
        // TODO - Should we clear the query params if they are not present in the response?
      }

      // TODO - We should compute the new path from the path params
      //
      //        Setting the path directly here requires the LLM to be consistent in its responses,
      //        meaning it needs to synchronize path params with the path.
      //        We tell it to do so, but if it makes a mistake, then things get confusing.
      if (path) {
        setPath(addServiceUrlIfBarePath(path));
      }

      // TODO - Validate path params
      if (pathParams) {
        updatePathParamValues(pathParams);
      } else {
        // TODO - Clear path params if they are not present in the response
      }

      if (validateKeyValueParamsFromResponse(headers)) {
        const newHeaders = createKeyValueParameters(headers);
        setRequestHeaders(newHeaders);
      } else {
        // TODO - Clear headers if they are not present in the response?
      }

      setShowAiGeneratedInputsBanner(true);
    });
  }, [
    generateRequestData,
    setBody,
    setPath,
    setQueryParams,
    setRequestHeaders,
    updatePathParamValues,
    toast,
    addServiceUrlIfBarePath,
  ]);

  return {
    showAiGeneratedInputsBanner:
      !ignoreAiInputsBanner && !!showAiGeneratedInputsBanner,
    setShowAiGeneratedInputsBanner,
    ignoreAiInputsBanner,
    setIgnoreAiInputsBanner,
    enabled: isAiEnabled,
    isLoadingParameters,
    fillInRequest,
    testingPersona,
    setTestingPersona,
  };
}

const KeyValueSchema = z.object({
  key: z.string(),
  value: z.string(),
});

type KeyValueObject = z.infer<typeof KeyValueSchema>;

const isKeyValueParamReplacement = (
  queryParam: unknown,
): queryParam is KeyValueObject => {
  return !!KeyValueSchema.safeParse(queryParam).success;
};

function validateKeyValueParamsFromResponse(
  queryParams: unknown,
): queryParams is Array<KeyValueObject> {
  return (
    !!queryParams &&
    Array.isArray(queryParams) &&
    queryParams.every((qp) => {
      return isKeyValueParamReplacement(qp);
    })
  );
}

/**
 * This is a local storage flag to hide the banner that shows up when AI generated inputs are being used.
 * This is used to prevent the banner from showing up after the user hits "Ignore" once.
 *
 * - Default value: false, don't ignore the banner
 * - Value if the localStorage contents are not json parseable: true, ignore the banner
 *
 * TODO - Persist this in the API instead
 */
export function useIgnoreAiGeneratedInputsBanner() {
  const LOCAL_STORAGE_KEY = "ignoreAiGeneratedInputsBanner";

  const [ignoreAiInputsBanner, setIgnoreAiInputsBanner] = useState<boolean>(
    () => {
      const storedValue = localStorage.getItem(LOCAL_STORAGE_KEY);
      try {
        return storedValue ? JSON.parse(storedValue) : false;
      } catch (e) {
        console.error("Failed to parse stored value:", e);
        return true;
      }
    },
  );

  useEffect(() => {
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify(ignoreAiInputsBanner),
    );
  }, [ignoreAiInputsBanner]);

  return {
    ignoreAiInputsBanner,
    setIgnoreAiInputsBanner,
  };
}
function tryPrettify(body: string) {
  try {
    const parsedBody = JSON.parse(body);
    const prettyBody = JSON.stringify(parsedBody, null, 2);
    return prettyBody;
  } catch {
    return body;
  }
}

function tryParseFormData(body: string) {
  try {
    const parsedBody = JSON.parse(body);
    if (parsedBody && typeof parsedBody === "object") {
      const keyValueEntries = Object.entries(parsedBody).map(
        ([key, value]) => ({
          key,
          value: `${value}`,
        }),
      );
      return keyValueEntries.map(({ key, value }) =>
        createFormDataParameter(key, value),
      );
    }
  } catch {
    return [];
  }
}
