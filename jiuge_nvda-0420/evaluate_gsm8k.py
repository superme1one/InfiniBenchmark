import argparse
import os
import re

import jsonlines
import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers.generation import GenerationConfig

ANS_RE = re.compile(r"#### (\-?[0-9\.\,]+)")
INVALID_ANS = "[invalid]"


def doc_to_text(doc):
    return (
        fewshot_prompt
        + "\nQuestion: "
        + doc["question"]
        + "\nLet's think step by step\n"
    )


def decode(tokens_list, tokenizer, raw_text_len):
    sents = []
    # print(len(tokens_list))
    for tokens in tokens_list:
        tokens = tokens.cpu().numpy().tolist()
        sent = tokenizer.decode(tokens[raw_text_len:])
        sent = sent.split("<|endoftext|>")[0]
        sent = sent.split("\n\n\n")[0]
        sent = sent.split("\n\n")[0]
        sent = sent.split("Question:")[0]
        sents.append(sent)
    return sents


def generate_sample(model, tokenizer, input_txt):
    input_ids = tokenizer.encode(input_txt)
    raw_text_len = len(input_ids)
    context_enc = torch.tensor([input_ids]).to(model.device)
    print(f"Input text: {input_txt}\n")
    outputs = model.generate(context_enc)
    output_text = decode(outputs, tokenizer, raw_text_len)[0]
    print(f"\nOutput text: {output_text}\n")
    return output_text


def extract_answer_hf(completion):
    match = ANS_RE.search(completion)
    if match:
        match_str = match.group(1).strip()
        match_str = match_str.replace(",", "")
        return eval(match_str)
    else:
        return INVALID_ANS


def extract_answer(completion):
    try:
        last_number = re.findall(r"\d+", completion)[-1]
        return eval(last_number)
    except:
        return INVALID_ANS


def is_correct(completion, answer):
    gold = extract_answer_hf(answer)
    assert gold != INVALID_ANS, "No ground truth answer found in the document."
    return extract_answer(completion) == gold


def parse_args():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    default_input = os.path.abspath(os.path.join(base_dir, "..", "data_sets", "GSM8k", "test.jsonl"))
    default_output = os.path.join(base_dir, "gsm8k_res.jsonl")
    default_prompt = os.path.join(base_dir, "gsm8k_prompt.txt")

    parser = argparse.ArgumentParser(description="Evaluate GSM8K with a local model.")
    parser.add_argument("--model-path", default=os.environ.get("MODEL_PATH", ""), help="Model directory path.")
    parser.add_argument("--gguf-file", default=os.environ.get("GGUF_FILE", ""), help="GGUF file path.")
    parser.add_argument("--input-file", default=default_input, help="GSM8K test jsonl path.")
    parser.add_argument("--output-file", default=default_output, help="Output jsonl path.")
    parser.add_argument("--prompt-file", default=default_prompt, help="Few-shot prompt text path.")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if not args.model_path or not args.gguf_file:
        raise ValueError("Both --model-path and --gguf-file are required (or set MODEL_PATH and GGUF_FILE).")

    with open(args.prompt_file, "r", encoding="utf-8") as f:
        fewshot_prompt = f.read()

    output_dir = os.path.dirname(os.path.abspath(args.output_file))
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    f_output = jsonlines.Writer(open(args.output_file, "w", encoding="utf-8"))
    f_input = jsonlines.Reader(open(args.input_file, "r", encoding="utf-8"))

    print("Loading tokenizer ...")
    tokenizer = AutoTokenizer.from_pretrained(
        args.model_path, gguf_file=args.gguf_file
    )

    print("Loading model ...")
    model = AutoModelForCausalLM.from_pretrained(
        args.model_path, gguf_file=args.gguf_file, device_map="auto"
    ).eval()
    model.generation_config = GenerationConfig.from_pretrained(
        args.model_path, gguf_file=args.gguf_file
    )
    model.generation_config.do_sample = False

    acc_res = []
    for doc in f_input:
        context = doc_to_text(doc)
        completion = generate_sample(model, tokenizer, context)
        answer = doc["answer"]
        acc = is_correct(completion, answer)
        doc["completion"] = completion
        doc["acc"] = acc
        f_output.write(doc)
        acc_res.append(acc)

    f_output.close()
    print("Acc: ", np.mean(acc_res))
