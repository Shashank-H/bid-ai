-- Strip only metadata keys; preserve recorded metrics, evidence IDs and checkpoint structure.
CREATE FUNCTION public.bid_remove_data_flags(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  cleaned jsonb;
  tool_content jsonb;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT COALESCE(jsonb_object_agg(key, public.bid_remove_data_flags(entry)), '{}'::jsonb)
      INTO cleaned FROM jsonb_each(value) AS fields(key, entry)
      WHERE key NOT IN ('synthetic', 'demoData');

      -- Tool messages embed a second JSON document in their content string.
      IF value->>'role' = 'tool' AND jsonb_typeof(value->'content') = 'string' THEN
        BEGIN
          tool_content := (value->>'content')::jsonb;
          cleaned := jsonb_set(cleaned, '{content}', to_jsonb(public.bid_remove_data_flags(tool_content)::text));
        EXCEPTION WHEN invalid_text_representation THEN
          NULL; -- Non-JSON message content stays unchanged.
        END;
      END IF;
      RETURN cleaned;
    WHEN 'array' THEN
      SELECT COALESCE(jsonb_agg(public.bid_remove_data_flags(entry) ORDER BY position), '[]'::jsonb)
      INTO cleaned FROM jsonb_array_elements(value) WITH ORDINALITY AS items(entry, position);
      RETURN cleaned;
    ELSE
      RETURN value;
  END CASE;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  ASSERT public.bid_remove_data_flags('{"evidence":[{"evidenceId":"e1","synthetic":true}],"demoData":true,"metrics":{"estimatedRevenue":12.5},"empty":[],"missing":null}'::jsonb)
    = '{"evidence":[{"evidenceId":"e1"}],"metrics":{"estimatedRevenue":12.5},"empty":[],"missing":null}'::jsonb;
  ASSERT (public.bid_remove_data_flags('{"role":"tool","content":"{\"synthetic\":true,\"value\":3}"}'::jsonb)->>'content')::jsonb
    = '{"value":3}'::jsonb;
  ASSERT public.bid_remove_data_flags('{"role":"tool","content":"ordinary text"}'::jsonb)
    = '{"role":"tool","content":"ordinary text"}'::jsonb;
END;
$$;
--> statement-breakpoint
UPDATE tool_executions SET result = public.bid_remove_data_flags(result)
WHERE result IS NOT NULL AND result IS DISTINCT FROM public.bid_remove_data_flags(result);
--> statement-breakpoint
DO $$
BEGIN
  -- Fresh installs create these tables later in postgres:init; they have no old data to clean.
  IF to_regclass('agent_checkpoints.checkpoints') IS NOT NULL THEN
    UPDATE agent_checkpoints.checkpoints
    SET checkpoint = public.bid_remove_data_flags(checkpoint), metadata = public.bid_remove_data_flags(metadata)
    WHERE checkpoint IS DISTINCT FROM public.bid_remove_data_flags(checkpoint)
      OR metadata IS DISTINCT FROM public.bid_remove_data_flags(metadata);
  END IF;

  -- The installed default serializer stores JSON as UTF-8; never rewrite opaque byte payloads.
  IF to_regclass('agent_checkpoints.checkpoint_blobs') IS NOT NULL THEN
    UPDATE agent_checkpoints.checkpoint_blobs
    SET blob = convert_to(public.bid_remove_data_flags(convert_from(blob, 'UTF8')::jsonb)::text, 'UTF8')
    WHERE CASE WHEN type = 'json' AND blob IS NOT NULL THEN
      convert_from(blob, 'UTF8')::jsonb IS DISTINCT FROM public.bid_remove_data_flags(convert_from(blob, 'UTF8')::jsonb)
      ELSE false END;
  END IF;

  IF to_regclass('agent_checkpoints.checkpoint_writes') IS NOT NULL THEN
    UPDATE agent_checkpoints.checkpoint_writes
    SET blob = convert_to(public.bid_remove_data_flags(convert_from(blob, 'UTF8')::jsonb)::text, 'UTF8')
    WHERE CASE WHEN type = 'json' THEN
      convert_from(blob, 'UTF8')::jsonb IS DISTINCT FROM public.bid_remove_data_flags(convert_from(blob, 'UTF8')::jsonb)
      ELSE false END;
  END IF;
END;
$$;
--> statement-breakpoint
DROP FUNCTION public.bid_remove_data_flags(jsonb);
